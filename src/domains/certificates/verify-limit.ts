import { createHash } from 'node:crypto';
import { logger } from '@/lib/observability/logger';
import { platformKey, redis } from '@/lib/redis';

/**
 * Fixed-window limits for public certificate lookups.
 *
 * Redis is the shared store. If it is unavailable, an in-process window still
 * limits this instance — the check does not fail open.
 */

const LOOKUP_LIMIT = 60;
const LOOKUP_WINDOW_SECONDS = 60;
const HOLDER_IP_LIMIT = 15;
const HOLDER_CODE_LIMIT = 30;
const HOLDER_WINDOW_SECONDS = 600;

const memory = new Map<string, { count: number; resetAt: number }>();

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

function memoryAllow(key: string, limit: number, windowSeconds: number): boolean {
  const now = Date.now();
  if (memory.size > 5_000) {
    for (const [storedKey, entry] of memory) {
      if (entry.resetAt <= now) memory.delete(storedKey);
    }
  }
  const current = memory.get(key);
  if (!current || current.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

async function allow(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const count = Number(await redis.incr(key));
    if (!Number.isFinite(count)) return false;
    if (count === 1) {
      try {
        await redis.expire(key, windowSeconds);
      } catch (err) {
        logger.error({ err }, 'certificate verification rate limit expiry failed');
      }
    }
    return count <= limit;
  } catch (err) {
    logger.error({ err }, 'certificate verification rate limit unavailable');
    return memoryAllow(key, limit, windowSeconds);
  }
}

/** Page lookup by client address. Missing addresses share one bucket. */
export async function allowCertificateLookup(ipAddress: string | null): Promise<boolean> {
  return allow(
    platformKey('cert-verify', 'lookup', digest(ipAddress ?? 'unknown')),
    LOOKUP_LIMIT,
    LOOKUP_WINDOW_SECONDS,
  );
}

/** Name check, limited per address and per verification code. */
export async function allowHolderCheck(
  ipAddress: string | null,
  code: string,
): Promise<boolean> {
  const ipOk = await allow(
    platformKey('cert-verify', 'holder-ip', digest(ipAddress ?? 'unknown')),
    HOLDER_IP_LIMIT,
    HOLDER_WINDOW_SECONDS,
  );
  const codeOk = await allow(
    platformKey('cert-verify', 'holder-code', digest(code)),
    HOLDER_CODE_LIMIT,
    HOLDER_WINDOW_SECONDS,
  );
  return ipOk && codeOk;
}
