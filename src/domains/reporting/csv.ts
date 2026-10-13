/**
 * Minimal RFC 4180 CSV serialiser — pure and testable.
 *
 * Handles the cases that actually bite: commas, double quotes, and newlines are
 * quoted/escaped; null/undefined become empty cells; Dates serialise as ISO
 * strings. CRLF line endings, as the spec prefers.
 */

export type CsvCell = string | number | boolean | Date | null | undefined;

function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'boolean'
        ? value
          ? 'true'
          : 'false'
        : String(value);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/** Serialise one row as a CSV line, including its CRLF terminator. */
export function toCsvLine(row: ReadonlyArray<CsvCell>): string {
  return row.map(escapeCell).join(',') + '\r\n';
}

/** Serialise a header row + data rows into a CSV document. */
export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<CsvCell>>,
): string {
  return [headers, ...rows].map(toCsvLine).join('');
}
