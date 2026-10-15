import { Socket } from 'node:net';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { pingRedis } from '@/lib/redis';
import { checkS3 } from '@/lib/storage/s3';
import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';

/**
 * Dependency reachability probes for readiness/health endpoints.
 *
 * Each probe is bounded by a timeout, never throws, and returns only a coarse
 * status — never connection strings, hostnames or credentials. These results
 * are safe to expose on an internal health endpoint.
 */

export type DependencyStatus = 'up' | 'down' | 'unknown';

export interface DependencyResult {
  status: DependencyStatus;
  /** Round-trip latency in milliseconds, when measured. */
  latencyMs?: number;
}

async function timed(fn: () => Promise<boolean>): Promise<DependencyResult> {
  const startedAt = Date.now();
  try {
    const ok = await fn();
    return { status: ok ? 'up' : 'down', latencyMs: Date.now() - startedAt };
  } catch {
    return { status: 'down', latencyMs: Date.now() - startedAt };
  }
}

/** Verify the database answers a trivial query within a timeout. */
export function checkDatabase(timeoutMs = 2_000): Promise<DependencyResult> {
  return timed(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        db.execute(sql`select 1`),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('db timeout')), timeoutMs);
        }),
      ]);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

/** Verify Redis responds to PING. */
export function checkRedis(): Promise<DependencyResult> {
  return timed(() => pingRedis());
}

/** Verify the evidence bucket is reachable. */
export function checkStorage(): Promise<DependencyResult> {
  return timed(() => checkS3());
}

/**
 * Cap the scanner probe well under the 1s readiness budget and the 3s kubelet
 * timeout. A ClamAV Service scaled to zero still has a ClusterIP; the connect
 * can black-hole instead of refusing, and socket inactivity timeouts do not
 * cover DNS or that connect. ClamAV is REPORTED but is NOT fatal — uploads stay
 * quarantined until a scanner is available.
 */
const CLAMAV_PROBE_TIMEOUT_MS = 500;

/**
 * Probe ClamAV using its clamd `PING`/`PONG` command over a raw TCP socket.
 */
export function checkClamAV(
  timeoutMs = CLAMAV_PROBE_TIMEOUT_MS,
): Promise<DependencyResult> {
  return timed(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = new Socket();
        let settled = false;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(ok);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        socket.setTimeout(timeoutMs);
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(env.CLAMAV_PORT, env.CLAMAV_HOST, () => {
          socket.write('zPING\0');
        });
        socket.on('data', (data) => {
          done(data.toString().includes('PONG'));
        });
      }),
  );
}

export interface ReadinessReport {
  ready: boolean;
  checks: {
    database: DependencyResult;
    redis: DependencyResult;
    storage: DependencyResult;
    clamav: DependencyResult;
  };
}

/**
 * One dependency fan-out per pod per window. `/api/ready` and `/api/health`
 * share it. Five seconds is long enough that a probe scrape cannot stampede
 * RDS, Redis, S3 or ClamAV, and short enough that a failover still drains
 * from the load balancer quickly.
 */
const READINESS_CACHE_MS = 5_000;

interface ReadinessCacheState {
  entry: { expiresAt: number; report: ReadinessReport } | null;
  inflight: Promise<ReadinessReport> | null;
}

const globalForReadiness = globalThis as unknown as {
  __blakpathReadiness?: ReadinessCacheState;
};

const readinessCache: ReadinessCacheState = globalForReadiness.__blakpathReadiness ?? {
  entry: null,
  inflight: null,
};
globalForReadiness.__blakpathReadiness = readinessCache;

/** Drop the per-process cache. Tests only — production reads it until expiry. */
export function __resetReadinessCache(): void {
  readinessCache.entry = null;
  readinessCache.inflight = null;
}

async function probeReadiness(): Promise<ReadinessReport> {
  const [database, redis, storage, clamav] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkStorage(),
    checkClamAV(),
  ]);

  const ready =
    database.status === 'up' && redis.status === 'up' && storage.status === 'up';

  if (!ready) {
    logger.warn(
      {
        signal: 'readiness_dependency_down',
        alert: true,
        database: database.status,
        redis: redis.status,
        storage: storage.status,
        clamav: clamav.status,
      },
      'Readiness check reported a dependency down',
    );
  }
  if (clamav.status !== 'up') {
    logger.warn(
      { signal: 'clamav_unavailable', alert: true, clamav: clamav.status },
      'ClamAV unavailable; evidence remains quarantined',
    );
  }

  return { ready, checks: { database, redis, storage, clamav } };
}

/**
 * Aggregate readiness. The service is READY when the core datastores it needs
 * to serve requests are up (database, Redis, storage). ClamAV is reported for
 * visibility but does not, on its own, mark the service not-ready.
 *
 * Results are cached per process for five seconds. Concurrent callers share one
 * in-flight probe so a burst cannot fan out once per request.
 */
export async function readinessReport(): Promise<ReadinessReport> {
  const cached = readinessCache.entry;
  if (cached && Date.now() < cached.expiresAt) return cached.report;
  if (readinessCache.inflight) return readinessCache.inflight;

  const pending = probeReadiness()
    .then((report) => {
      readinessCache.entry = { report, expiresAt: Date.now() + READINESS_CACHE_MS };
      return report;
    })
    .finally(() => {
      if (readinessCache.inflight === pending) readinessCache.inflight = null;
    });
  readinessCache.inflight = pending;
  return pending;
}
