/**
 * Break-glass state machine — pure and testable.
 *
 * Emergency cross-tenant access is deliberately hard: a platform operator
 * REQUESTS scoped, time-boxed access; a DIFFERENT person inside the target
 * organisation APPROVES (or denies) it; the operator then ACTIVATES it; and it
 * can be REVOKED or simply EXPIRES. Every hop is separately gated and audited.
 *
 * PRODUCT INVARIANT: break-glass grants temporary READ access for a stated
 * support purpose. It never confers determination power and never bypasses the
 * audit trail — actions taken under it are flagged as break-glass.
 */

export const BREAK_GLASS_STATUSES = [
  'requested',
  'approved',
  'denied',
  'active',
  'expired',
  'revoked',
] as const;
export type BreakGlassStatus = (typeof BREAK_GLASS_STATUSES)[number];

/** A requested grant may be approved or denied (by someone in the tenant). */
export function canApprove(status: BreakGlassStatus): boolean {
  return status === 'requested';
}
export function canDeny(status: BreakGlassStatus): boolean {
  return status === 'requested';
}
/** Only an approved grant may be activated (by the requester). */
export function canActivate(status: BreakGlassStatus): boolean {
  return status === 'approved';
}
/** An approved or active grant may be revoked. */
export function canRevoke(status: BreakGlassStatus): boolean {
  return status === 'approved' || status === 'active';
}
/**
 * A review is a human record of access that has started. It may be filed while
 * the grant is still live, or after it expires or is revoked.
 */
export function canReview(status: BreakGlassStatus): boolean {
  return status === 'active' || status === 'expired' || status === 'revoked';
}
/** Terminal states — no further transitions. */
export function isTerminal(status: BreakGlassStatus): boolean {
  return status === 'denied' || status === 'expired' || status === 'revoked';
}

/** Is a grant currently LIVE (active and not past its expiry)? */
export function isLive(
  status: BreakGlassStatus,
  expiresAt: Date | null,
  now: Date,
): boolean {
  if (status !== 'active') return false;
  return !expiresAt || expiresAt.getTime() > now.getTime();
}

/**
 * Post-use review is due this many weekdays after activation.
 * Counted in {@link BREAK_GLASS_REVIEW_TIME_ZONE}. Public holidays are not
 * excluded: the product has no holiday calendar.
 */
export const BREAK_GLASS_REVIEW_BUSINESS_DAYS = 5;
export const BREAK_GLASS_REVIEW_TIME_ZONE = 'Australia/Sydney';

interface CivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

function civilPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

function civilTime(instant: Date, timeZone: string): CivilTime {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const hour = Number(civilPart(parts, 'hour'));
  return {
    year: Number(civilPart(parts, 'year')),
    month: Number(civilPart(parts, 'month')),
    day: Number(civilPart(parts, 'day')),
    hour: hour === 24 ? 0 : hour,
    minute: Number(civilPart(parts, 'minute')),
    second: Number(civilPart(parts, 'second')),
    weekday: civilPart(parts, 'weekday'),
  };
}

/** UTC instant whose wall clock in `timeZone` matches `civil`. */
function civilToUtc(civil: Omit<CivilTime, 'weekday'>, timeZone: string): Date {
  const desired = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  );
  let utc = desired;
  for (let pass = 0; pass < 3; pass += 1) {
    const seen = civilTime(new Date(utc), timeZone);
    const seenAsUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      seen.second,
    );
    const delta = desired - seenAsUtc;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

function isWeekday(weekday: string): boolean {
  return !weekday.startsWith('Sat') && !weekday.startsWith('Sun');
}

/**
 * Add `businessDays` weekdays to `start`, keeping the local time of day.
 * Weekends in `timeZone` are skipped. Public holidays are not.
 */
export function addBusinessDays(
  start: Date,
  businessDays: number,
  timeZone: string = BREAK_GLASS_REVIEW_TIME_ZONE,
): Date {
  if (!Number.isInteger(businessDays) || businessDays < 0) {
    throw new Error('businessDays must be a non-negative integer.');
  }
  if (businessDays === 0) return new Date(start.getTime());

  let cursor = new Date(start.getTime());
  let remaining = businessDays;
  let guard = businessDays * 3 + 14;
  while (remaining > 0) {
    if (guard <= 0) throw new Error('Could not advance business days.');
    guard -= 1;
    const civil = civilTime(cursor, timeZone);
    const next = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + 1));
    cursor = civilToUtc(
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
        hour: civil.hour,
        minute: civil.minute,
        second: civil.second,
      },
      timeZone,
    );
    if (isWeekday(civilTime(cursor, timeZone).weekday)) remaining -= 1;
  }
  return cursor;
}

/** A grant that was used and still has no review after its due instant. */
export function isReviewOverdue(
  status: BreakGlassStatus,
  reviewDueAt: Date | null,
  reviewedAt: Date | null,
  now: Date,
): boolean {
  if (reviewedAt || !reviewDueAt || !canReview(status)) return false;
  return reviewDueAt.getTime() < now.getTime();
}
