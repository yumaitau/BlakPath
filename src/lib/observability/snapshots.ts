/**
 * Pure shapes for the worker's operational gauges. IO stays in the worker.
 */

export interface QueueCounts {
  waiting: number;
  delayed: number;
  paused: number;
  prioritized: number;
  failed: number;
}

/** Jobs not yet running. Active jobs are in flight, not backlog. */
export function queueDepth(counts: QueueCounts): number {
  return counts.waiting + counts.delayed + counts.paused + counts.prioritized;
}

/** Seconds since `timestampMs`. No job → 0. */
export function ageSeconds(timestampMs: number | null, nowMs: number): number {
  if (timestampMs == null) return 0;
  return Math.max(0, (nowMs - timestampMs) / 1000);
}

export function quarantineOldestAgeSeconds(oldest: Date | null, nowMs: number): number {
  if (!oldest) return 0;
  return Math.max(0, (nowMs - oldest.getTime()) / 1000);
}

/** ClamAV `VERSION` replies look like `ClamAV 1.4.1/27340/Tue Oct 13 00:00:00 2026`. */
export function parseClamdVersionDate(raw: string): Date | null {
  const reply = raw.replace(/\0/g, '').trim();
  const match = reply.match(/^ClamAV\s+\S+\/\d+\/(.+)$/);
  if (!match?.[1]) return null;
  // clamd prints the signature date with no zone. The database clock is UTC.
  const parsed = new Date(`${match[1]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function signatureAgeSeconds(signedAt: Date, nowMs: number): number {
  return Math.max(0, (nowMs - signedAt.getTime()) / 1000);
}

export function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
