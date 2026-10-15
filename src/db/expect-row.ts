/**
 * Insert and update `.returning()` rows are typed `T | undefined`. A missing
 * row is a programming error: the statement was supposed to write one row.
 * Domain outcomes (not found, denied, conflict) use their own errors.
 */
export function expectRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${what} to be returned from the database.`);
  }
  return row;
}
