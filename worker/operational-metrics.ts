import { metrics, type BatchObservableResult } from '@opentelemetry/api';
import { and, count, inArray, isNull, min } from 'drizzle-orm';
import { db, sqlClient } from '@/db/client';
import { evidence } from '@/db/schema';
import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import {
  createQueueGauges,
  type QueueGaugeInstruments,
} from '@/lib/observability/metrics';
import { scrubErrorForLog } from '@/lib/observability/scrub';
import {
  ageSeconds,
  asDate,
  parseClamdVersionDate,
  quarantineOldestAgeSeconds,
  queueDepth,
  signatureAgeSeconds,
  type QueueCounts,
} from '@/lib/observability/snapshots';
import { getQueue, QueueName } from '@/lib/queues';
import { redis } from '@/lib/redis';
import { readClamdVersion } from '@/lib/scanning/clamav';

/**
 * Worker-owned gauges: queue backlog, quarantine age, ClamAV signature age and
 * Postgres connection counts. One worker holds a short Redis lock so replicas
 * do not double-publish the same cluster-wide numbers.
 *
 * Counts and ages only. No organisation ids, object keys or file names.
 */

const LOCK_KEY = 'bp:metrics:leader';
const LOCK_TTL_MS = 50_000;
const BACKLOG_TYPES = ['waiting', 'delayed', 'paused', 'prioritized'] as const;

let publishing = false;

function logFailure(err: unknown, message: string, extra?: Record<string, string>): void {
  logger.error({ err: scrubErrorForLog(err), ...extra }, message);
}

async function isLeader(): Promise<boolean> {
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  return acquired === 'OK';
}

async function queueSnapshot(name: QueueName, nowMs: number) {
  const queue = getQueue(name);
  const counts = await queue.getJobCounts(...BACKLOG_TYPES, 'failed');
  const snapshot: QueueCounts = {
    waiting: counts.waiting ?? 0,
    delayed: counts.delayed ?? 0,
    paused: counts.paused ?? 0,
    prioritized: counts.prioritized ?? 0,
    failed: counts.failed ?? 0,
  };
  let oldestMs: number | null = null;
  for (const type of BACKLOG_TYPES) {
    const [job] = await queue.getJobs([type], 0, 0, true);
    if (job && (oldestMs === null || job.timestamp < oldestMs)) oldestMs = job.timestamp;
  }
  return {
    depth: queueDepth(snapshot),
    oldestAge: ageSeconds(oldestMs, nowMs),
    failed: snapshot.failed,
  };
}

async function quarantineSnapshot(nowMs: number) {
  const [row] = await db
    .select({
      backlog: count(),
      oldest: min(evidence.createdAt),
    })
    .from(evidence)
    .where(
      and(
        inArray(evidence.status, ['pending', 'quarantined']),
        isNull(evidence.deletedAt),
      ),
    );
  return {
    backlog: Number(row?.backlog ?? 0),
    oldestAge: quarantineOldestAgeSeconds(asDate(row?.oldest), nowMs),
  };
}

async function signatureAge(nowMs: number): Promise<number | null> {
  const raw = await readClamdVersion();
  if (!raw) return null;
  const signedAt = parseClamdVersionDate(raw);
  return signedAt ? signatureAgeSeconds(signedAt, nowMs) : null;
}

async function poolUsage(): Promise<Array<{ pool: string; open: number }>> {
  const rows = await sqlClient<Array<{ application_name: string; open: number }>>`
    select application_name, count(*)::int as open
    from pg_stat_activity
    where datname = current_database()
      and application_name in ('blakpath-web', 'blakpath-worker', 'blakpath')
    group by application_name
  `;
  return rows.map((row) => ({ pool: row.application_name, open: Number(row.open) }));
}

async function publish(
  result: BatchObservableResult,
  gauges: QueueGaugeInstruments,
): Promise<void> {
  if (!publishing) return;
  try {
    if (!(await isLeader())) return;
  } catch (err) {
    logFailure(err, 'metrics leader lock failed');
    return;
  }

  const nowMs = Date.now();
  for (const name of Object.values(QueueName)) {
    try {
      const snapshot = await queueSnapshot(name, nowMs);
      result.observe(gauges.depth, snapshot.depth, { queue: name });
      result.observe(gauges.oldestAge, snapshot.oldestAge, { queue: name });
      result.observe(gauges.failed, snapshot.failed, { queue: name });
    } catch (err) {
      logFailure(err, 'queue gauge collection failed', { queue: name });
    }
  }

  try {
    const quarantine = await quarantineSnapshot(nowMs);
    result.observe(gauges.quarantineBacklog, quarantine.backlog);
    result.observe(gauges.quarantineOldestAge, quarantine.oldestAge);
  } catch (err) {
    logFailure(err, 'quarantine gauge collection failed');
  }

  try {
    const age = await signatureAge(nowMs);
    if (age != null) result.observe(gauges.signatureAge, age);
  } catch (err) {
    logFailure(err, 'clamav signature gauge collection failed');
  }

  try {
    result.observe(gauges.poolMax, env.DATABASE_POOL_MAX);
    for (const row of await poolUsage()) {
      result.observe(gauges.poolOpen, row.open, { pool: row.pool });
    }
  } catch (err) {
    logFailure(err, 'db pool gauge collection failed');
  }
}

/**
 * Start gauge collection. Call after OpenTelemetry `start()` so the meter
 * binds to the real provider. The returned function stops further publishes.
 */
export function startOperationalMetrics(): () => void {
  publishing = true;
  const gauges = createQueueGauges();
  metrics.getMeter('blakpath').addBatchObservableCallback(
    (result) => {
      return publish(result, gauges);
    },
    [
      gauges.depth,
      gauges.oldestAge,
      gauges.failed,
      gauges.quarantineBacklog,
      gauges.quarantineOldestAge,
      gauges.signatureAge,
      gauges.poolOpen,
      gauges.poolMax,
    ],
  );
  return () => {
    publishing = false;
  };
}
