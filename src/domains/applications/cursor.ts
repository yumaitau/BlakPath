/**
 * Opaque keyset cursor for the application register.
 *
 * The page position is `(createdAt, id)` ordered descending. Offset paging
 * skips rows and cannot use the created-at index once a filter is applied;
 * this cursor seeks the next row directly.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApplicationCursor {
  readonly createdAt: string;
  readonly id: string;
}

export function encodeApplicationCursor(cursor: ApplicationCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeApplicationCursor(token: string): ApplicationCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const createdAt = 'createdAt' in parsed ? parsed.createdAt : undefined;
    const id = 'id' in parsed ? parsed.id : undefined;
    if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
    if (!UUID.test(id)) return null;
    const time = Date.parse(createdAt);
    if (Number.isNaN(time)) return null;
    const cursor = { createdAt: new Date(time).toISOString(), id };
    // Node's base64url decoder ignores leftover bits, so a trailing
    // character can still parse. Only the exact encoding is a cursor.
    if (encodeApplicationCursor(cursor) !== token) return null;
    return cursor;
  } catch {
    return null;
  }
}
