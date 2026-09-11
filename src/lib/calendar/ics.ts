/**
 * RFC 5545 iCalendar serialiser + parser.
 *
 * The serialiser is adapted from RangerOS's dependency-free `calendar-ics`
 * (exporting to Outlook / Google / Apple Calendar); the parser is new so
 * BlakPath can also IMPORT `.ics` files. Both are pure — no DB, no network — so
 * they unit-test without any harness. Times are emitted in UTC ("Z"); every
 * major client converts to the viewer's local zone on import.
 */

export type IcsEventStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

export interface IcsEvent {
  uid: string;
  start: Date;
  end?: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  status?: IcsEventStatus;
  categories?: string[];
  /** Recurrence rule (RRULE value without the name). */
  rrule?: string | null;
  /** Exception dates as UTC Dates. */
  exdates?: Date[];
}

const DEFAULT_DURATION_MS = 60 * 60 * 1000;

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/** YYYYMMDDTHHMMSSZ in UTC. */
export function formatIcsUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** Escape per RFC 5545 §3.3.11 (TEXT): backslash, semicolon, comma, newline. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Reverse {@link escapeIcsText} for parsed values. */
export function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Fold content lines to <=75 octets (RFC 5545 §3.1); continuation lines begin
 * with a single space. Byte-aware so multi-byte characters are never split.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    const max = chunks.length === 0 ? 75 : 74; // continuation lines lose 1 to the leading space
    if (bytes + charBytes > max) {
      chunks.push(chunk);
      chunk = char;
      bytes = charBytes;
    } else {
      chunk += char;
      bytes += charBytes;
    }
  }
  chunks.push(chunk);
  return chunks.join('\r\n ');
}

function eventLines(event: IcsEvent, stamp: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${formatIcsUtc(event.start)}`,
    `DTEND:${formatIcsUtc(event.end ?? new Date(event.start.getTime() + DEFAULT_DURATION_MS))}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.url) lines.push(`URL:${escapeIcsText(event.url)}`);
  if (event.status) lines.push(`STATUS:${event.status}`);
  if (event.rrule) lines.push(`RRULE:${event.rrule}`);
  if (event.exdates && event.exdates.length > 0) {
    lines.push(`EXDATE:${event.exdates.map((d) => formatIcsUtc(d)).join(',')}`);
  }
  if (event.categories && event.categories.length > 0) {
    lines.push(`CATEGORIES:${event.categories.map(escapeIcsText).join(',')}`);
  }
  lines.push('END:VEVENT');
  return lines;
}

/** Serialise events into a single VCALENDAR document. */
export function buildIcs(input: {
  events: IcsEvent[];
  calendarName?: string;
  now: Date;
}): string {
  const stamp = formatIcsUtc(input.now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BlakPath//Meetings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(input.calendarName ?? 'BlakPath Meetings')}`,
    ...input.events.flatMap((event) => eventLines(event, stamp)),
    'END:VCALENDAR',
  ];
  // CRLF line endings + trailing CRLF are required by the spec; fold each line.
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------------------------
 * Parser
 * ------------------------------------------------------------------------- */

/** A single event parsed from an .ics document. */
export interface ParsedIcsEvent {
  uid?: string;
  start: Date;
  end?: Date;
  summary: string;
  description?: string;
  location?: string;
  status?: string;
  rrule?: string;
  exdates?: Date[];
}

/** Unfold RFC 5545 lines: a leading space/tab continues the previous line. */
function unfoldLines(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Parse an iCalendar date-time. Handles UTC (`...Z`), floating local (no zone,
 * treated as UTC), and date-only (`YYYYMMDD`) forms. Returns null if unparseable.
 */
export function parseIcsDate(value: string): Date | null {
  const v = value.trim();
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (dateTime) {
    const [, y, mo, d, h, mi, s] = dateTime;
    return new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    );
  }
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  }
  return null;
}

/** Split a content line into its property name (before `:`/`;`) and value. */
function splitProperty(line: string): { name: string; value: string } {
  // Property may carry parameters after a semicolon (e.g. DTSTART;TZID=...:val).
  const colon = line.indexOf(':');
  if (colon === -1) return { name: line.toUpperCase(), value: '' };
  const rawName = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const name = rawName.split(';')[0]!.toUpperCase();
  return { name, value };
}

/**
 * Parse an .ics document into events. Malformed or dateless VEVENTs are skipped
 * rather than throwing, so one bad entry never rejects an otherwise-valid file.
 */
export function parseIcs(text: string): ParsedIcsEvent[] {
  const lines = unfoldLines(text);
  const events: ParsedIcsEvent[] = [];

  let inEvent = false;
  let current: {
    uid?: string;
    start?: Date | null;
    end?: Date | null;
    summary?: string;
    description?: string;
    location?: string;
    status?: string;
    rrule?: string;
    exdates?: Date[];
  } = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      inEvent = false;
      if (current.start) {
        events.push({
          ...(current.uid ? { uid: current.uid } : {}),
          start: current.start,
          ...(current.end ? { end: current.end } : {}),
          summary: current.summary ?? '(untitled)',
          ...(current.description ? { description: current.description } : {}),
          ...(current.location ? { location: current.location } : {}),
          ...(current.status ? { status: current.status } : {}),
          ...(current.rrule ? { rrule: current.rrule } : {}),
          ...(current.exdates && current.exdates.length > 0 ? { exdates: current.exdates } : {}),
        });
      }
      continue;
    }
    if (!inEvent) continue;

    const { name, value } = splitProperty(line);
    switch (name) {
      case 'UID':
        current.uid = unescapeIcsText(value);
        break;
      case 'DTSTART':
        current.start = parseIcsDate(value);
        break;
      case 'DTEND':
        current.end = parseIcsDate(value);
        break;
      case 'SUMMARY':
        current.summary = unescapeIcsText(value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeIcsText(value);
        break;
      case 'LOCATION':
        current.location = unescapeIcsText(value);
        break;
      case 'STATUS':
        current.status = value.trim().toUpperCase();
        break;
      case 'RRULE':
        current.rrule = value.trim();
        break;
      case 'EXDATE': {
        const dates = value
          .split(',')
          .map((part) => parseIcsDate(part))
          .filter((d): d is Date => d !== null);
        if (dates.length > 0) current.exdates = [...(current.exdates ?? []), ...dates];
        break;
      }
      default:
        break;
    }
  }

  return events;
}
