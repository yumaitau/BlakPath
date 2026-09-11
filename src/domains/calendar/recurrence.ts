/**
 * Pure recurrence + conflict helpers. No DB, no network — unit-tested.
 * Supports master RRULE subset used by BlakPath: FREQ=DAILY|WEEKLY with
 * COUNT (1..365) or UNTIL (UTC basic format). Anything else returns single.
 */

export interface Occurrence {
  start: Date;
  end: Date | null;
}

interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY';
  count?: number;
  until?: Date;
}

export function parseRrule(rrule: string | null | undefined): ParsedRule | null {
  if (!rrule) return null;
  const match = /^FREQ=(DAILY|WEEKLY);(COUNT=(\d{1,3})|UNTIL=(\d{8}T\d{6}Z))$/.exec(
    rrule.trim(),
  );
  if (!match) return null;
  const freq = match[1] as 'DAILY' | 'WEEKLY';
  if (match[3]) {
    const count = Math.min(365, Math.max(1, Number(match[3])));
    return { freq, count };
  }
  if (match[4]) {
    const v = match[4];
    const until = new Date(
      Date.UTC(
        Number(v.slice(0, 4)),
        Number(v.slice(4, 6)) - 1,
        Number(v.slice(6, 8)),
        Number(v.slice(9, 11)),
        Number(v.slice(11, 13)),
        Number(v.slice(13, 15)),
      ),
    );
    return { freq, until };
  }
  return null;
}

/** Expand master into occurrences within [from, to]. Caps at 365. */
export function expandOccurrences(input: {
  start: Date;
  end?: Date | null;
  rrule?: string | null;
  from: Date;
  to: Date;
}): Occurrence[] {
  const { start, end, rrule, from, to } = input;
  const rule = parseRrule(rrule);
  if (!rule) {
    return start >= from && start <= to ? [{ start, end: end ?? null }] : [];
  }
  const stepDays = rule.freq === 'DAILY' ? 1 : 7;
  const durationMs = end ? end.getTime() - start.getTime() : 0;
  const out: Occurrence[] = [];
  const max = rule.count ?? 365;
  for (let i = 0; i < max; i += 1) {
    const s = new Date(start.getTime() + i * stepDays * 86_400_000);
    if (s > to) break;
    if (rule.until && s > rule.until) break;
    const e = end ? new Date(s.getTime() + durationMs) : null;
    if (s >= from && s <= to) out.push({ start: s, end: e });
    if (out.length >= 365) break;
  }
  return out;
}

/** True when [aStart,aEnd) overlaps [bStart,bEnd). Open end = 1h default. */
export function overlaps(
  aStart: Date,
  aEnd: Date | null,
  bStart: Date,
  bEnd: Date | null,
): boolean {
  const aE = aEnd ? aEnd.getTime() : aStart.getTime() + 3_600_000;
  const bE = bEnd ? bEnd.getTime() : bStart.getTime() + 3_600_000;
  return aStart.getTime() < bE && bStart.getTime() < aE;
}
