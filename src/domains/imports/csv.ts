/**
 * Minimal RFC 4180 CSV parser — pure and testable.
 *
 * Handles what spreadsheet exports actually produce: quoted cells containing
 * commas, doubled quotes and line breaks; CRLF or LF line endings; a UTF-8 BOM;
 * and a trailing newline. Blank lines are dropped. An unterminated quoted cell
 * is a malformed file, not a guess, so it throws.
 */

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/** Parse CSV text into rows of raw string cells. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  const endRow = () => {
    row.push(cell);
    cell = '';
    // A line with a single empty cell is a blank line — skip it.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (cell.length > 0) {
        throw new CsvParseError(
          `Unexpected quote inside an unquoted cell (row ${rows.length + 1}).`,
        );
      }
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && input[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += ch;
      i += 1;
    }
  }
  if (inQuotes) {
    throw new CsvParseError('The file ends inside a quoted cell.');
  }
  if (cell.length > 0 || row.length > 0) endRow();
  return rows;
}
