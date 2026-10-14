import { createHash, randomBytes } from 'node:crypto';

/**
 * SCIM credential primitives — pure and testable.
 *
 * A token is `scim_<random>`. Only its SHA-256 hash is stored; the same
 * one-way transform runs on creation and on every request lookup. The prefix
 * is a non-secret display hint.
 */

export const SCIM_TOKEN_PREFIX = 'scim_';

/** SHA-256 hex of a raw token. Deterministic — used on write and on lookup. */
export function hashScimToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Fresh bearer token. Returned to the creator once; never persisted raw. */
export function generateScimToken(): string {
  return `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Is this a syntactically plausible SCIM token? */
export function looksLikeScimToken(raw: string): boolean {
  return raw.startsWith(SCIM_TOKEN_PREFIX) && raw.length >= SCIM_TOKEN_PREFIX.length + 32;
}

/** Non-secret display prefix: `scim_` + first 6 secret chars. */
export function scimDisplayPrefix(raw: string): string {
  return raw.slice(0, SCIM_TOKEN_PREFIX.length + 6);
}
