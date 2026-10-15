/**
 * Minimal RFC 4180 CSV serialiser — pure and testable.
 *
 * Handles the cases that actually bite: commas, double quotes, and newlines are
 * quoted/escaped; null/undefined become empty cells; Dates serialise as ISO
 * strings. CRLF line endings, as the spec prefers.
 *
 * A cell whose text begins with `=`, `+`, `-`, `@`, tab, or CR is prefixed with
 * `'` so spreadsheet apps keep it as text. RFC 4180 quoting still applies to
 * the prefixed value.
 */

export type CsvCell = string | number | boolean | Date | null | undefined;

/** Leading characters spreadsheets treat as the start of a formula. */
const FORMULA_LEADING = /^[=+\-@\t\r]/;

function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'boolean'
        ? value
          ? 'true'
          : 'false'
        : String(value);
  const raw = FORMULA_LEADING.test(text) ? `'${text}` : text;
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
