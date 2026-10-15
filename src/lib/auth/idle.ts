/**
 * Inactivity timing for the staff UI.
 *
 * Pure so it can be unit-tested and shared: the browser component feeds it the
 * last activity time (shared across tabs via localStorage) and the clock, and
 * renders whatever phase comes back.
 */

/** How long before the idle sign-out the warning appears. */
export const IDLE_WARNING_MS = 2 * 60 * 1000;

/** localStorage key holding the last activity time, shared across tabs. */
export const LAST_ACTIVITY_STORAGE_KEY = 'blakpath:last-activity';

export type IdlePhase = 'active' | 'warning' | 'expired';

export interface IdleStatus {
  phase: IdlePhase;
  /** Milliseconds until the idle sign-out (0 once expired). */
  remainingMs: number;
}

export function idleStatus(
  now: number,
  lastActivityAt: number,
  timeoutMs: number,
  warningMs: number = IDLE_WARNING_MS,
): IdleStatus {
  const remainingMs = Math.max(0, lastActivityAt + timeoutMs - now);
  if (remainingMs === 0) return { phase: 'expired', remainingMs };
  if (remainingMs <= Math.min(warningMs, timeoutMs)) {
    return { phase: 'warning', remainingMs };
  }
  return { phase: 'active', remainingMs };
}

/** "1:05"-style countdown for the warning dialog. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Parses a stored activity timestamp, ignoring junk and future values. */
export function parseStoredActivity(raw: string | null, now: number): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > now) return null;
  return value;
}
