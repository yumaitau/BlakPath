import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { computeEventHash, type HashableAuditEvent } from '@/domains/audit/hash';
import { PLATFORM_AUDIT_CHAIN_KEY } from '@/domains/audit/chain-id';
import {
  verifyAndCheckpoint,
  verifyChainFromPages,
  type AuditChainCursor,
  type AuditCheckpointAnchor,
  type AuditCheckpointInsert,
  type AuditPageQuery,
  type AuditVerificationReader,
  type StoredAuditEvent,
} from '@/domains/audit/verify';
import { processAuditVerifyJob } from '../../worker/audit-verify';

const root = fileURLToPath(new URL('../..', import.meta.url));

function appendEvent(
  rows: StoredAuditEvent[],
  organisationId: string | null,
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
    reason: null,
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

function chain(count: number, organisationId: string | null): StoredAuditEvent[] {
  const rows: StoredAuditEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    appendEvent(rows, organisationId);
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
        organisationId: PLATFORM_AUDIT_CHAIN_KEY,
        correlationId: 'platform-verify',
        jobId: 'job-1',
      },
      logger,
      { reader: store.reader, pageSize: 2 },
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

  it('verifies 5M events under a fixed memory ceiling', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--max-old-space-size=256',
        '--import',
        'tsx',
        'tests/unit/audit-verify-memory.runner.ts',
      ],
      { cwd: root, encoding: 'utf8', timeout: 120_000 },
    );
    const growth = Number(/growth=(\d+)/.exec(stdout)?.[1]);
    expect(stdout).toContain('OK events=5000000');
    expect(growth).toBeLessThan(64 * 1024 * 1024);
  }, 120_000);
});
