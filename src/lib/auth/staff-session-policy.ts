/**
 * Staff session lifetime.
 *
 * A session that has selected an organisation is capped at 12 hours from
 * creation and an idle window of 30–60 minutes (default 45). The idle clock is
 * `lastActivityAt` (the session row's `updatedAt`). Activity is recorded only
 * once it is at least 60 seconds old, because any write refreshes `updatedAt`.
 *
 * Sessions with no active organisation are outside this policy.
 */

export const STAFF_SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;
export const STAFF_IDLE_TIMEOUT_MIN_SECONDS = 30 * 60;
export const STAFF_IDLE_TIMEOUT_MAX_SECONDS = 60 * 60;
export const STAFF_IDLE_TIMEOUT_DEFAULT_SECONDS = 45 * 60;
/** Do not write the session row more often than this; a write moves `updatedAt`. */
export const STAFF_ACTIVITY_TOUCH_SECONDS = 60;

export type StaffSessionDecision =
  | { state: 'valid'; touch: boolean; expiresAt: Date }
  | { state: 'expired'; reason: 'absolute' | 'idle' };

/**
 * Clamp a stored idle timeout into the allowed range. Null, non-finite, or
 * out-of-range values become the nearest legal value (default when unknown).
 */
export function resolveStaffIdleTimeoutSeconds(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return STAFF_IDLE_TIMEOUT_DEFAULT_SECONDS;
  }
  if (value < STAFF_IDLE_TIMEOUT_MIN_SECONDS) return STAFF_IDLE_TIMEOUT_MIN_SECONDS;
  if (value > STAFF_IDLE_TIMEOUT_MAX_SECONDS) return STAFF_IDLE_TIMEOUT_MAX_SECONDS;
  return Math.floor(value);
}

/**
 * PURE decision. Exactly `idle` or exactly 12 hours is still valid. Older than
 * either bound is expired. Invalid timestamps expire (absolute).
 */
export function evaluateStaffSession(
  session: { createdAt: Date; lastActivityAt: Date },
  now: Date,
  idleTimeoutSeconds: number,
): StaffSessionDecision {
  const created = session.createdAt.getTime();
  const activity = session.lastActivityAt.getTime();
  const t = now.getTime();
  if (!Number.isFinite(created) || !Number.isFinite(activity) || !Number.isFinite(t)) {
    return { state: 'expired', reason: 'absolute' };
  }

  const idle = resolveStaffIdleTimeoutSeconds(idleTimeoutSeconds);
  if (t - created > STAFF_SESSION_ABSOLUTE_SECONDS * 1000) {
    return { state: 'expired', reason: 'absolute' };
  }
  if (t - activity > idle * 1000) {
    return { state: 'expired', reason: 'idle' };
  }

  const absoluteEnd = created + STAFF_SESSION_ABSOLUTE_SECONDS * 1000;
  const idleEnd = t + idle * 1000;
  const ageSeconds = (t - activity) / 1000;
  return {
    state: 'valid',
    touch: ageSeconds >= STAFF_ACTIVITY_TOUCH_SECONDS,
    expiresAt: new Date(Math.min(absoluteEnd, idleEnd)),
  };
}
