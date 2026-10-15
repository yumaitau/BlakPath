/**
 * Turn a plain-text import into application rows.
 *
 * One person per line: `Name` or `Name, low|normal|high`. A header line
 * `Name, Priority` and lines starting with `#` are ignored. Nothing here
 * creates or decides an application — the import service does the write.
 */

const PRIORITIES = ['low', 'normal', 'high'] as const;
type Priority = (typeof PRIORITIES)[number];

export interface ImportLineRow {
  applicantName: string;
  priority?: Priority;
}

export interface ImportLineError {
  line: number;
  message: string;
}

export function parseApplicationImportLines(text: string): {
  rows: ImportLineRow[];
  errors: ImportLineError[];
} {
  const rows: ImportLineRow[] = [];
  const errors: ImportLineError[] = [];
  const lines = text.split(/\r?\n/);
  let headerSkipped = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (!headerSkipped && /^name\s*,\s*priority\s*$/i.test(trimmed)) {
      headerSkipped = true;
      continue;
    }
    headerSkipped = true;

    const comma = trimmed.indexOf(',');
    const applicantName = (comma === -1 ? trimmed : trimmed.slice(0, comma)).trim();
    const priorityText =
      comma === -1
        ? ''
        : trimmed
            .slice(comma + 1)
            .trim()
            .toLowerCase();

    if (applicantName.length === 0 || applicantName.length > 200) {
      errors.push({
        line: lineNumber,
        message: 'Enter a name of 1 to 200 characters.',
      });
      continue;
    }
    if (priorityText.length === 0) {
      rows.push({ applicantName });
      continue;
    }
    if (!PRIORITIES.includes(priorityText as Priority)) {
      errors.push({
        line: lineNumber,
        message: 'Priority must be low, normal or high.',
      });
      continue;
    }
    rows.push({ applicantName, priority: priorityText as Priority });
  }

  if (rows.length > 100) {
    errors.push({ line: 0, message: 'Import up to 100 applications at a time.' });
  }

  return { rows, errors };
}
