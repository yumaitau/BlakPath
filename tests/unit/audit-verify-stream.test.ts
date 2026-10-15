import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { computeEventHash, type HashableAuditEvent } from '@/domains/audit/hash';
import {
  PLATFORM_CHAIN_ID,
  type AnchoredChainProbe,
  type AuditAnchorStore,
} from '@/domains/audit/anchor';
import { createHmacAnchorSigner } from '@/domains/audit/anchor-sign';
import {
  verifyAndCheckpoint,
  verifyChainFromPages,
  type AuditChainCursor,
  type AuditCheckpointAnchor,
  type AuditCheckpointInsert,
  type AuditPageQuery,
  type AuditVerificationReader,
  type StoredAuditEvent,
  type VerifyFromCheckpointResult,
} from '@/domains/audit/verify';
import { processAuditVerifyJob } from '../../worker/audit-verify';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ORG = '018f1a20-7c3a-7b1a-8f2a-0a0a0a0a0a0b';
const SECRET = 'stream-test-anchor-secret-at-least-32-chars';
const DAY_ONE = new Date('2026-10-13T02:00:00.000Z');
const DAY_TWO = new Date('2026-10-14T02:00:00.000Z');

function anchorStore(): AuditAnchorStore & { objects: Map<string, string> } {
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

/** In-memory twin of `auditChainProbe`: absolute length through the tip. */
function memoryProbe(
  events: readonly StoredAuditEvent[],
): (verified: VerifyFromCheckpointResult) => Promise<AnchoredChainProbe> {
  return async (verified) => {
    const tip = verified.tip;
    const position = tip ? events.findIndex((event) => event.id === tip.id) : -1;
    const eventCount = verified.ok && tip ? position + 1 : 0;
    return {
      ok: verified.ok,
      eventCount,
      async hashesAt(positions) {
        const view: { length: number; [position: number]: string } = {
          length: eventCount,
        };
        for (const at of positions) {
          const hash = at >= 0 && at < eventCount ? events[at]?.hash : undefined;
          if (hash) view[at] = hash;
        }
        return view;
      },
    };
  };
}

const quietLogger = {
  error() {
    return undefined;
  },
  info() {
    return undefined;
  },
} as unknown as Logger;

function appendEvent(
  rows: StoredAuditEvent[],
  organisationId: string | null,
  reason: string | null = null,
): StoredAuditEvent {
  const previous = rows[rows.length - 1];
  const sequence = rows.length;
  const timestamp = new Date(Date.UTC(2026, 0, 1) + sequence);
  const id = `evt-${String(sequence).padStart(6, '0')}`;
  const prevHash = previous?.hash ?? null;
  const hashable: HashableAuditEvent = {
    id,
    organisationId,
    timestamp: timestamp.toISOString(),
    actorUserId: null,
    actingRole: 'system',
    sessionId: null,
    action: 'record.viewed',
    resourceType: 'application',
    resourceId: `resource-${sequence}`,
    result: 'success',
    reason,
    ipAddress: null,
    userAgent: null,
    correlationId: 'corr',
    requestId: null,
    beforeMeta: null,
    afterMeta: null,
  };
  const row: StoredAuditEvent = {
    ...hashable,
    timestamp,
    beforeMeta: null,
    afterMeta: null,
    prevHash,
    hash: computeEventHash(prevHash, hashable),
  };
  rows.push(row);
  return row;
}

function chain(
  count: number,
  organisationId: string | null,
  reason: string | null = null,
): StoredAuditEvent[] {
  const rows: StoredAuditEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    appendEvent(rows, organisationId, reason);
  }
  return rows;
}

function pageAfter(
  events: readonly StoredAuditEvent[],
  query: AuditPageQuery,
): StoredAuditEvent[] {
  return events
    .filter((event) => {
      if (event.organisationId !== query.organisationId) {
        return false;
      }
      const after = query.after;
      if (!after) {
        return true;
      }
      const time = event.timestamp.getTime() - after.timestamp.getTime();
      if (time > 0) {
        return true;
      }
      if (time < 0) {
        return false;
      }
      return event.id > after.id;
    })
    .sort((left, right) => {
      const time = left.timestamp.getTime() - right.timestamp.getTime();
      return time !== 0 ? time : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })
    .slice(0, query.limit);
}

function memoryReader(events: StoredAuditEvent[]): {
  reader: AuditVerificationReader;
  checkpoints: Array<AuditCheckpointAnchor & { endHash: string }>;
  cursors: Array<AuditChainCursor | null>;
  served: string[][];
} {
  const checkpoints: Array<
    AuditCheckpointAnchor & { organisationId: string | null; endHash: string }
  > = [];
  const cursors: Array<AuditChainCursor | null> = [];
  const served: string[][] = [];
  const reader: AuditVerificationReader = {
    async latestCheckpoint(organisationId) {
      const rows = checkpoints.filter((row) => row.organisationId === organisationId);
      return rows[rows.length - 1] ?? null;
    },
    async eventsAt(organisationId, periodEnd) {
      return events.filter(
        (event) =>
          event.organisationId === organisationId &&
          event.timestamp.getTime() === periodEnd.getTime(),
      );
    },
    async loadPage(query) {
      cursors.push(query.after);
      const page = pageAfter(events, query);
      served.push(page.map((event) => event.id));
      return page;
    },
    async insertCheckpoint(input: AuditCheckpointInsert) {
      const id = `cp-${checkpoints.length + 1}`;
      checkpoints.push({
        id,
        organisationId: input.organisationId,
        periodEnd: input.periodEnd,
        endHash: input.endHash,
        eventCount: input.eventCount,
      });
      return id;
    },
  };
  return { reader, checkpoints, cursors, served };
}

describe('audit chain streaming verification', () => {
  it('verifies a multi-page chain and stops at the first tampered page', async () => {
    const intact = chain(5, 'org-1');
    const clean = await verifyChainFromPages(
      'org-1',
      (after, limit) =>
        Promise.resolve(pageAfter(intact, { organisationId: 'org-1', after, limit })),
      { pageSize: 2 },
    );
    expect(clean.ok).toBe(true);
    expect(clean.eventCount).toBe(5);
    expect(clean.endHash).toBe(intact[4]?.hash);

    const tampered = chain(5, 'org-1');
    const broken = tampered[3];
    if (!broken) {
      throw new Error('expected a fourth event');
    }
    broken.hash = 'tampered';
    const result = await verifyChainFromPages(
      'org-1',
      (after, limit) =>
        Promise.resolve(pageAfter(tampered, { organisationId: 'org-1', after, limit })),
      { pageSize: 2 },
    );
    expect(result.ok).toBe(false);
    expect(result.divergence).toMatchObject({
      eventId: broken.id,
      index: 3,
      reason: 'hash_mismatch',
    });
    expect(result.eventCount).toBe(4);
  });

  it('writes a checkpoint each advancing run and resumes the next run from it', async () => {
    const events = chain(4, null);
    const store = memoryReader(events);

    const first = await verifyAndCheckpoint(null, { reader: store.reader, pageSize: 2 });
    expect(first.ok).toBe(true);
    expect(first.checkpointWritten).toBe(true);
    expect(first.resumedFrom).toBeNull();
    expect(first.eventCount).toBe(4);
    expect(store.served.flat()).toEqual(events.map((event) => event.id));

    const tip = events[3];
    if (!tip) {
      throw new Error('expected a tip event');
    }
    appendEvent(events, null);
    appendEvent(events, null);
    store.cursors.length = 0;
    store.served.length = 0;

    const second = await verifyAndCheckpoint(null, { reader: store.reader, pageSize: 2 });
    expect(second.checkpointWritten).toBe(true);
    expect(second.resumedFrom).toEqual({ timestamp: tip.timestamp, id: tip.id });
    expect(store.cursors[0]).toEqual({ timestamp: tip.timestamp, id: tip.id });
    expect(second.eventCount).toBe(2);
    expect(store.served.flat()).toEqual(events.slice(4).map((event) => event.id));
    expect(store.checkpoints).toHaveLength(2);
    expect(store.checkpoints[1]?.endHash).toBe(events[5]?.hash);

    store.cursors.length = 0;
    store.served.length = 0;
    const third = await verifyAndCheckpoint(null, { reader: store.reader, pageSize: 2 });
    expect(third.ok).toBe(true);
    expect(third.checkpointWritten).toBe(false);
    expect(third.checkpointId).toBe('cp-2');
    const latest = events[5];
    if (!latest) {
      throw new Error('expected the latest platform event');
    }
    expect(third.resumedFrom).toEqual({ timestamp: latest.timestamp, id: latest.id });
    expect(store.checkpoints).toHaveLength(2);
    expect(store.served).toEqual([[]]);
  });

  it('detects platform-chain tampering and emits the alarm signal', async () => {
    const events = chain(3, null);
    const broken = events[1];
    if (!broken) {
      throw new Error('expected a second event');
    }
    broken.hash = 'tampered';
    const store = memoryReader(events);
    const errors: Array<Record<string, unknown>> = [];
    const logger = {
      error(bindings: Record<string, unknown>) {
        errors.push(bindings);
      },
      info() {
        return undefined;
      },
    } as unknown as Logger;

    const result = await processAuditVerifyJob(
      {
        organisationId: PLATFORM_CHAIN_ID,
        platformChain: true,
        correlationId: 'platform-verify',
        jobId: 'job-1',
      },
      logger,
      {
        verify: { reader: store.reader, pageSize: 2 },
        store: anchorStore(),
        signer: createHmacAnchorSigner(SECRET),
        probe: memoryProbe(events),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.checkpointWritten).toBe(false);
    expect(store.checkpoints).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      signal: 'audit_integrity_failure',
      alert: true,
      metric: 'AuditIntegrityFailures',
      chain: 'platform',
      organisationId: null,
      eventId: broken.id,
      index: 1,
      reason: 'hash_mismatch',
      correlationId: 'platform-verify',
      jobId: 'job-1',
    });

    const alarm = readFileSync(
      fileURLToPath(
        new URL('../../infra/aws/operational-alerts.example.yaml', import.meta.url),
      ),
      'utf8',
    );
    expect(alarm).toContain('{ $.signal = "audit_integrity_failure" && $.alert = true }');
    expect(alarm).toContain('MetricName: AuditIntegrityFailures');
    expect(alarm).toContain('AlarmName: blakpath-audit-integrity-failure');
  });

  it('resumes from a checkpoint and still fails the anchor when the tail is removed', async () => {
    const events = chain(4, null);
    const reader = memoryReader(events);
    const anchors = anchorStore();
    const signer = createHmacAnchorSigner(SECRET);
    const job = {
      organisationId: PLATFORM_CHAIN_ID,
      platformChain: true,
      correlationId: 'c',
    };
    const deps = {
      verify: { reader: reader.reader, pageSize: 2 },
      store: anchors,
      signer,
      probe: memoryProbe(events),
    };

    const day1 = await processAuditVerifyJob(job, quietLogger, { ...deps, now: DAY_ONE });
    expect(day1.anchor.status).toBe('anchored');
    expect(day1.checkpointWritten).toBe(true);

    // Drop the anchored tail and forge a checkpoint for the new, shorter tip.
    events.splice(2);
    const forgedTip = events[1];
    if (!forgedTip) throw new Error('expected a second event');
    await reader.reader.insertCheckpoint({
      organisationId: null,
      periodStart: forgedTip.timestamp,
      periodEnd: forgedTip.timestamp,
      eventCount: 1,
      startHash: forgedTip.hash,
      endHash: forgedTip.hash,
    });
    reader.served.length = 0;

    const day2 = await processAuditVerifyJob(job, quietLogger, { ...deps, now: DAY_TWO });
    expect(day2.ok).toBe(true);
    expect(day2.resumedFrom).toEqual({
      timestamp: forgedTip.timestamp,
      id: forgedTip.id,
    });
    expect(reader.served).toEqual([[]]);
    expect(day2.anchor).toMatchObject({
      status: 'anchor_mismatch',
      reason: 'chain_truncated',
    });
    expect(day2.checkpointWritten).toBe(false);
    expect(anchors.objects.size).toBe(1);
  });

  it('resumes from a forged checkpoint and still fails the anchor when the chain is recomputed', async () => {
    const events = chain(4, ORG);
    const reader = memoryReader(events);
    const anchors = anchorStore();
    const signer = createHmacAnchorSigner(SECRET);
    const job = { organisationId: ORG, correlationId: 'c' };
    const probe = (rows: StoredAuditEvent[]) => memoryProbe(rows);
    const deps = {
      store: anchors,
      signer,
      verify: { reader: reader.reader, pageSize: 2 },
    };

    const day1 = await processAuditVerifyJob(job, quietLogger, {
      ...deps,
      probe: probe(events),
      now: DAY_ONE,
    });
    expect(day1.anchor.status).toBe('anchored');

    // Replace every row with a freshly hashed chain, then checkpoint its tip.
    events.splice(0, events.length, ...chain(4, ORG, 'rewritten'));
    const tip = events[3];
    if (!tip) throw new Error('expected a fourth event');
    await reader.reader.insertCheckpoint({
      organisationId: ORG,
      periodStart: tip.timestamp,
      periodEnd: tip.timestamp,
      eventCount: 4,
      startHash: tip.hash,
      endHash: tip.hash,
    });

    const day2 = await processAuditVerifyJob(job, quietLogger, {
      ...deps,
      probe: probe(events),
      now: DAY_TWO,
    });
    expect(day2.ok).toBe(true);
    expect(day2.anchor).toMatchObject({
      status: 'anchor_mismatch',
      reason: 'head_mismatch',
    });
    expect(day2.checkpointWritten).toBe(false);
    expect(anchors.objects.size).toBe(1);
  });

  // Async so the vitest worker keeps answering RPC while the child runs. One
  // million events is enough to expose a per-event leak against the 64 MiB
  // ceiling; set AUDIT_VERIFY_MEMORY_EVENTS=5000000 to run the full 5M check.
  const memoryEvents = Number(process.env.AUDIT_VERIFY_MEMORY_EVENTS ?? 1_000_000);
  it(`verifies ${memoryEvents} events under a fixed memory ceiling`, async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--expose-gc',
        '--max-old-space-size=256',
        '--import',
        'tsx',
        'tests/unit/audit-verify-memory.runner.ts',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 280_000,
        env: { ...process.env, AUDIT_VERIFY_MEMORY_EVENTS: String(memoryEvents) },
      },
    );
    const growth = Number(/growth=(\d+)/.exec(stdout)?.[1]);
    expect(stdout).toContain(`OK events=${memoryEvents}`);
    expect(growth).toBeLessThan(64 * 1024 * 1024);
  }, 300_000);
});
