import { createHmac } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { organisationKeys } from '@/db/schema';
import {
  getOrganisationKey,
  markOrganisationKeyUnavailable,
} from '@/domains/organisation-keys';
import { dekCacheKey, sharedDekCache, type DekCache } from './dek-cache';
import { TenantKeyUnavailableError } from './errors';
import { asKmsKeyAccessError, type KeyProvider } from './key-provider';
import { logger } from '@/lib/observability/logger';
import { createKeyProvider } from './provider';

/**
 * Keyed HMAC blind index for reference and name lookup.
 *
 * The HMAC key is a data key generated once under the tenant CMK with purpose
 * `blind-index`, then stored wrapped on `organisation_keys`. Equality and
 * whole-word lookup use the digest. There is no plaintext index and no
 * substring match inside a word. This is a lookup, not a judgement.
 */

const PURPOSE = 'blind-index';

function httpStatus(
  status:
    'active' | 'disabled' | 'pending_deletion' | 'unavailable' | 'pending_validation',
): 423 | 503 | null {
  switch (status) {
    case 'active':
      return null;
    case 'disabled':
    case 'pending_deletion':
    case 'pending_validation':
      return 423;
    case 'unavailable':
      return 503;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/** Trim, lowercase, and collapse internal whitespace. */
export function normalizeSearchTerm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Full normalised string plus each whitespace-separated word. */
export function nameTokens(value: string): string[] {
  const normalized = normalizeSearchTerm(value);
  if (!normalized) return [];
  return [...new Set([normalized, ...normalized.split(' ')])];
}

export function hmacSearchTerm(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(normalizeSearchTerm(value)).digest('hex');
}

async function hmacKey(
  organisationId: string,
  provider: KeyProvider,
  cache: DekCache,
): Promise<Buffer> {
  const row = await getOrganisationKey(organisationId);
  if (!row) throw new TenantKeyUnavailableError(organisationId, 503);
  const denied = httpStatus(row.status);
  if (denied !== null) throw new TenantKeyUnavailableError(organisationId, denied);

  const context = { org_id: organisationId, purpose: PURPOSE };
  const keyRow = row;

  async function unwrap(wrapped: Buffer): Promise<Buffer> {
    const cacheId = dekCacheKey(keyRow.kmsKeyArn, context, wrapped);
    const cached = cache.get(cacheId);
    if (cached) return cached;
    try {
      const dek = Buffer.from(
        await provider.decrypt({
          keyArn: keyRow.kmsKeyArn,
          ciphertextBlob: wrapped,
          encryptionContext: context,
        }),
      );
      cache.set(cacheId, dek, organisationId);
      return dek;
    } catch (error) {
      const access = asKmsKeyAccessError(error);
      if (!access) throw error;
      cache.evictOrganisation(organisationId);
      try {
        await markOrganisationKeyUnavailable(organisationId, access.kmsError);
      } catch (markError) {
        logger.error({ err: markError }, 'failed to mark tenant key unavailable');
      }
      throw new TenantKeyUnavailableError(organisationId, 503);
    }
  }

  if (row.blindIndexWrappedDek) {
    return unwrap(Buffer.from(row.blindIndexWrappedDek, 'base64'));
  }

  const generated = await provider
    .generateDataKey({ keyArn: row.kmsKeyArn, encryptionContext: context })
    .catch(async (error: unknown) => {
      const access = asKmsKeyAccessError(error);
      if (!access) throw error;
      cache.evictOrganisation(organisationId);
      try {
        await markOrganisationKeyUnavailable(organisationId, access.kmsError);
      } catch (markError) {
        logger.error({ err: markError }, 'failed to mark tenant key unavailable');
      }
      throw new TenantKeyUnavailableError(organisationId, 503);
    });

  const plaintext = Buffer.from(generated.plaintext);
  generated.plaintext.fill(0);
  const wrapped = generated.ciphertextBlob.toString('base64');
  const claimed = await db
    .update(organisationKeys)
    .set({ blindIndexWrappedDek: wrapped })
    .where(
      and(
        eq(organisationKeys.organisationId, organisationId),
        isNull(organisationKeys.blindIndexWrappedDek),
      ),
    )
    .returning({ blindIndexWrappedDek: organisationKeys.blindIndexWrappedDek });

  if (claimed[0]) {
    cache.set(
      dekCacheKey(row.kmsKeyArn, context, generated.ciphertextBlob),
      plaintext,
      organisationId,
    );
    return plaintext;
  }

  plaintext.fill(0);
  const winner = await getOrganisationKey(organisationId);
  if (!winner?.blindIndexWrappedDek) {
    throw new TenantKeyUnavailableError(organisationId, 503);
  }
  return unwrap(Buffer.from(winner.blindIndexWrappedDek, 'base64'));
}

async function withKey<T>(organisationId: string, apply: (key: Buffer) => T): Promise<T> {
  const key = await hmacKey(organisationId, createKeyProvider(), sharedDekCache());
  try {
    return apply(key);
  } finally {
    key.fill(0);
  }
}

export async function blindIndex(organisationId: string, value: string): Promise<string> {
  return withKey(organisationId, (key) => hmacSearchTerm(key, value));
}

export async function blindIndexTokens(
  organisationId: string,
  value: string,
): Promise<string[]> {
  const tokens = nameTokens(value);
  if (tokens.length === 0) return [];
  return withKey(organisationId, (key) =>
    tokens.map((token) => createHmac('sha256', key).update(token).digest('hex')),
  );
}

/** Empty after normalisation means "no query", not "match everything". */
export async function applicationSearchMac(
  organisationId: string,
  query: string,
): Promise<string | null> {
  if (!normalizeSearchTerm(query)) return null;
  return blindIndex(organisationId, query);
}
