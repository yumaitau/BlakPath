import { AuthorizationError } from '@/lib/permissions/errors';

/**
 * Per-process SCIM request limit.
 *
 * Keyed by credential hash (or a shared bucket for malformed tokens). This is
 * a backstop on a single instance; it does not replace an edge limit.
 */

const WINDOW_MS = 60_000;
const DEFAULT_MAX = 300;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function prune(now: number): void {
  if (buckets.size <= 10_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function enforceScimRateLimit(
  bucketKey: string,
  now = Date.now(),
  max = DEFAULT_MAX,
): void {
  prune(now);
  const existing = buckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  existing.count += 1;
  if (existing.count > max) {
    throw new AuthorizationError('POLICY_DENIED');
  }
}
