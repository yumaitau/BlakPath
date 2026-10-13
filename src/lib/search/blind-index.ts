import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Blind-index helpers for finding a record by a typed prefix.
 *
 * The stored token is an HMAC of a normalised prefix, not the name or
 * reference itself. Search compares tokens for equality, so it still works
 * after those columns are encrypted: hash the plaintext (or the typed query)
 * before encryption and look the token up. The HMAC key is derived from
 * whatever master key the caller supplies. A later per-tenant key replaces
 * that input; the token shape stays the same, and tokens are rebuilt.
 *
 * This does not rank, score, or infer anything about a person. A match only
 * means the typed prefix occurred on a record someone already entered.
 */

export const SEARCH_PREFIX_MIN = 2;
export const SEARCH_PREFIX_MAX = 32;
const MAX_QUERY_TOKENS = 12;

export type SearchField = 'reference' | 'name';

/** Lower-case, strip punctuation, and collapse whitespace. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/ +/g, ' ');
}

/**
 * Prefixes worth indexing for one field. Each word is indexed from
 * {@link SEARCH_PREFIX_MIN} characters up to {@link SEARCH_PREFIX_MAX}, so a
 * btree/hash lookup of the HMAC can satisfy "starts with" without scanning
 * the source column.
 */
export function indexedPrefixes(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const prefixes = new Set<string>();
  for (const word of normalized.split(' ')) {
    const limit = Math.min(word.length, SEARCH_PREFIX_MAX);
    for (let length = SEARCH_PREFIX_MIN; length <= limit; length += 1) {
      prefixes.add(word.slice(0, length));
    }
  }
  return [...prefixes];
}

/**
 * Words the user actually typed, capped so one query cannot fan out forever.
 * Words shorter than two characters are dropped (a single letter is not
 * selective and is not indexed).
 */
export function queryTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const tokens: string[] = [];
  for (const word of normalized.split(' ')) {
    if (word.length < SEARCH_PREFIX_MIN) continue;
    tokens.push(word.slice(0, SEARCH_PREFIX_MAX));
    if (tokens.length === MAX_QUERY_TOKENS) break;
  }
  return tokens;
}

/** True when the user typed something that cannot hit the index. */
export function isUnderMinimumSearch(value: string): boolean {
  return value.trim().length > 0 && queryTokens(value).length === 0;
}

/** 32-byte search key, separated from the master key by an HKDF label. */
export function searchBlindKey(masterKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterKey, Buffer.alloc(0), 'blakpath-search-blind-index-v1', 32),
  );
}

/** Decode the base64 master key and derive the search key. Rejects a bad length. */
export function searchBlindKeyFromMaster(masterKeyBase64: string): Buffer {
  const master = Buffer.from(masterKeyBase64, 'base64');
  if (master.length !== 32) {
    throw new Error('ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes');
  }
  return searchBlindKey(master);
}

/**
 * HMAC for one prefix. The organisation id and field are inside the MAC so
 * the same letters in another tenant, or on the other field, do not compare
 * equal.
 */
export function blindSearchToken(
  key: Buffer,
  organisationId: string,
  field: SearchField,
  prefix: string,
): string {
  return createHmac('sha256', key)
    .update(`${organisationId}\0${field}\0${prefix}`, 'utf8')
    .digest('base64url');
}
