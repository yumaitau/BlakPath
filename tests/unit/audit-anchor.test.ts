import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  anchorObjectKey,
  canonicalAnchorBody,
  hashAnchorBody,
  parseSignedAnchor,
  settleAuditChain,
  type AuditAnchorStore,
} from '@/domains/audit/anchor';
import { createHmacAnchorSigner } from '@/domains/audit/anchor-sign';
import { AUDIT_APPEND_ONLY_STATEMENTS, auditAppGrantStatements } from '@/db/audit-guard';
import { computeEventHash, type HashableAuditEvent } from '@/domains/audit/hash';
import { migrationRoleIssue, resolveMigrationDatabaseUrl } from '@/db/migration-url';

const ORG = '018f1a20-7c3a-7b1a-8f2a-0a0a0a0a0a0a';
const SECRET = 'anchor-test-secret-at-least-32-chars';
const DAY_ONE = new Date('2026-10-13T02:00:00.000Z');
const DAY_TWO = new Date('2026-10-14T02:00:00.000Z');

function memoryStore(): AuditAnchorStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async get(key) {
      return objects.get(key) ?? null;
    },
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
    async put(key, body) {
      if (objects.has(key)) throw new Error(`anchor already exists: ${key}`);
      objects.set(key, body);
    },
  };
}

function event(id: string, reason: string | null = null): HashableAuditEvent {
  return {
    id,
    organisationId: ORG,
    timestamp: `2026-10-13T00:00:0${id}.000Z`,
    actorUserId: null,
    actingRole: 'system',
    sessionId: null,
    action: 'record.viewed',
    resourceType: 'application',
    resourceId: id,
    result: 'success',
    reason,
    ipAddress: null,
    userAgent: null,
    correlationId: 'corr',
    requestId: null,
    beforeMeta: null,
    afterMeta: null,
  };
}

function chainHashes(reasons: Array<string | null> = [null, null, null, null]): string[] {
  const hashes: string[] = [];
  let prev: string | null = null;
  reasons.forEach((reason, index) => {
    const hash = computeEventHash(prev, event(String(index + 1), reason));
    hashes.push(hash);
    prev = hash;
  });
  return hashes;
}

describe('audit chain anchors', () => {
  it('writes one daily anchor per chain and leaves the next run unchanged', async () => {
    const store = memoryStore();
    const signer = createHmacAnchorSigner(SECRET);
    const hashes = chainHashes();
    const chain = { ok: true as const, hashes, eventCount: hashes.length };

    const first = await settleAuditChain({
      organisationId: ORG,
      chain,
      store,
      signer,
      now: DAY_ONE,
    });
    const platform = await settleAuditChain({
      organisationId: null,
      chain,
      store,
      signer,
      now: DAY_ONE,
    });
    const again = await settleAuditChain({
      organisationId: ORG,
      chain,
      store,
      signer,
      now: DAY_ONE,
    });

    expect(first.status).toBe('anchored');
    expect(platform.status).toBe('anchored');
    expect(again.status).toBe('already_anchored');
    expect([...store.objects.keys()].sort()).toEqual([
      anchorObjectKey(ORG, '2026-10-13'),
      anchorObjectKey('platform', '2026-10-13'),
    ]);
  });

  it('fails verification when the tail is removed', async () => {
    const store = memoryStore();
    const signer = createHmacAnchorSigner(SECRET);
    const hashes = chainHashes();
    await settleAuditChain({
      organisationId: ORG,
      chain: { ok: true, hashes, eventCount: hashes.length },
      store,
      signer,
      now: DAY_ONE,
    });

    const truncated = hashes.slice(0, hashes.length - 2);
    const outcome = await settleAuditChain({
      organisationId: ORG,
      chain: { ok: true, hashes: truncated, eventCount: truncated.length },
      store,
      signer,
      now: DAY_TWO,
    });

    expect(outcome).toMatchObject({
      status: 'anchor_mismatch',
      reason: 'chain_truncated',
    });
    expect(store.objects.size).toBe(1);
  });

  it('fails verification when the chain is recomputed', async () => {
    const store = memoryStore();
    const signer = createHmacAnchorSigner(SECRET);
    const hashes = chainHashes();
    await settleAuditChain({
      organisationId: ORG,
      chain: { ok: true, hashes, eventCount: hashes.length },
      store,
      signer,
      now: DAY_ONE,
    });

    const rewritten = chainHashes(['rewritten', 'rewritten', 'rewritten', 'rewritten']);
    const outcome = await settleAuditChain({
      organisationId: ORG,
      chain: { ok: true, hashes: rewritten, eventCount: rewritten.length },
      store,
      signer,
      now: DAY_TWO,
    });

    expect(outcome).toMatchObject({ status: 'anchor_mismatch', reason: 'head_mismatch' });
    expect(store.objects.size).toBe(1);
  });

  it('links the next day to the previous anchor and rejects a broken link', async () => {
    const store = memoryStore();
    const signer = createHmacAnchorSigner(SECRET);
    const hashes = chainHashes();
    await settleAuditChain({
      organisationId: ORG,
      chain: { ok: true, hashes, eventCount: hashes.length },
      store,
      signer,
      now: DAY_ONE,
    });
    const extended = chainHashes([null, null, null, null, null]);
    const next = await settleAuditChain({
      organisationId: ORG,
      chain: { ok: true, hashes: extended, eventCount: extended.length },
      store,
      signer,
      now: DAY_TWO,
    });
    expect(next.status).toBe('anchored');

    const first = parseSignedAnchor(
      store.objects.get(anchorObjectKey(ORG, '2026-10-13')) ?? '',
    );
    const second = parseSignedAnchor(
      store.objects.get(anchorObjectKey(ORG, '2026-10-14')) ?? '',
    );
    expect(first).not.toBeNull();
    expect(second?.prevAnchorHash).toBe(first ? hashAnchorBody(first) : null);

    const head = extended[extended.length - 1];
    expect(head).toBeTruthy();
    const forgedBody = {
      v: 1 as const,
      chainId: ORG,
      organisationId: ORG,
      day: '2026-10-15',
      eventCount: extended.length,
      chainHeadHash: head ?? '',
      prevAnchorHash: null,
      anchoredAt: '2026-10-15T02:00:00.000Z',
    };
    const forgedSignature = await signer.sign(canonicalAnchorBody(forgedBody));
    store.objects.set(
      anchorObjectKey(ORG, '2026-10-15'),
      JSON.stringify({ ...forgedBody, signature: forgedSignature }),
    );

    const outcome = await settleAuditChain({
      organisationId: ORG,
      chain: { ok: true, hashes: extended, eventCount: extended.length },
      store,
      signer,
      now: new Date('2026-10-16T02:00:00.000Z'),
    });
    expect(outcome).toMatchObject({
      status: 'anchor_mismatch',
      reason: 'prev_anchor_mismatch',
    });
  });
});

describe('migration role separation', () => {
  it('uses the application URL outside production and rejects a shared production role', () => {
    expect(
      resolveMigrationDatabaseUrl({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://blakpath_app:pw@localhost/blakpath',
      }),
    ).toBe('postgres://blakpath_app:pw@localhost/blakpath');

    expect(
      migrationRoleIssue({
        DATABASE_URL: 'postgres://blakpath_app:pw@db.internal/blakpath',
        DATABASE_MIGRATION_URL: 'postgres://blakpath_migrator:pw@db.internal/blakpath',
      }),
    ).toBeNull();
    expect(() =>
      resolveMigrationDatabaseUrl({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://blakpath_app:pw@db.internal/blakpath',
        DATABASE_MIGRATION_URL: 'postgres://blakpath_app:other@db.internal/blakpath',
      }),
    ).toThrow(/different database role/);
  });
});

describe('audit append-only privileges', () => {
  it('installs update, delete and truncate guards and limits the application role', () => {
    const sql = AUDIT_APPEND_ONLY_STATEMENTS.join('\n');
    expect(sql).toContain('BEFORE UPDATE');
    expect(sql).toContain('BEFORE DELETE');
    expect(sql).toContain('BEFORE TRUNCATE');
    expect(sql).toContain('ENABLE ALWAYS TRIGGER');
    expect(sql).toContain('audit_events');
    expect(sql).toContain('audit_integrity_checkpoints');

    const migration = readFileSync(
      'src/db/migrations/0019_audit-chain-predecessor.sql',
      'utf8',
    );
    for (const statement of AUDIT_APPEND_ONLY_STATEMENTS) {
      expect(migration).toContain(statement);
    }

    expect(() => auditAppGrantStatements('blakpath_app;drop')).toThrow(/unsafe/);
    const grants = auditAppGrantStatements('blakpath_app');
    const revoke = grants.findIndex((statement) =>
      statement.startsWith('REVOKE ALL PRIVILEGES ON TABLE audit_events FROM'),
    );
    const selectInsert = grants.indexOf(
      'GRANT SELECT, INSERT ON TABLE audit_events TO blakpath_app',
    );
    expect(revoke).toBeGreaterThan(-1);
    expect(selectInsert).toBeGreaterThan(revoke);
    expect(
      grants.some((statement) =>
        statement.includes('GRANT UPDATE ON TABLE audit_events'),
      ),
    ).toBe(false);
  });
});
