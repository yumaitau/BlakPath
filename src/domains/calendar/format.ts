/**
 * Pure local-time formatting for calendar reminders.
 *
 * Event times are stored as UTC; each event keeps the IANA zone it was authored
 * in (the organisation's working zone). Reminders show the time in that zone,
 * with the zone abbreviation, so "9:30 am AEDT" reads correctly to staff rather
 * than a raw UTC ISO string. An unknown or malformed zone falls back to the
 * platform default instead of failing the sweep.
 */

export const DEFAULT_EVENT_TIMEZONE = 'Australia/Sydney';

function format(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at);
}

/** Format an instant in the event's zone, e.g. "Thursday 15 October 2026 at 9:30 am AEDT". */
export function formatEventTime(at: Date, timeZone: string | null | undefined): string {
  try {
    return format(at, timeZone || DEFAULT_EVENT_TIMEZONE);
  } catch {
    return format(at, DEFAULT_EVENT_TIMEZONE);
  }
}
