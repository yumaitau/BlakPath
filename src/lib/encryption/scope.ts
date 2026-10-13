import { env, isProduction } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import {
  getOrganisationKey,
  markOrganisationKeyUnavailable,
  type OrganisationKeyStatus,
} from '@/domains/organisation-keys';
import { dekCacheKey, sharedDekCache, type DekCache } from './dek-cache';
import {
  decryptFieldV1,
  ENVELOPE_VERSION,
  fieldAad,
  isEnvelopeV2,
  kidFor,
  openField,
  parseKid,
  sealField,
  type EncryptedField,
  type EncryptedFieldV2,
  type FieldBinding,
} from './envelope';
import { TenantKeyUnavailableError } from './errors';
import type { EncryptionContext, KeyProvider } from './key-provider';
import { asKmsKeyAccessError } from './key-provider';
import { createKeyProvider, LOCAL_PLATFORM_ARN } from './provider';

/** Sentinel organisation id for data that is not owned by a tenant. */
export const PLATFORM_ORGANISATION_ID = 'platform';

export type FieldPurpose = 'field' | 'platform';

export interface TenantKeyMaterial {
  readonly organisationId: string;
  readonly kmsKeyArn: string;
  readonly keyVersion: number;
  readonly status: OrganisationKeyStatus;
}

export interface ScopeOptions {
  readonly provider?: KeyProvider;
  readonly cache?: DekCache;
  readonly purpose?: FieldPurpose;
  readonly onUnavailable?: (kmsError: string) => Promise<void> | void;
}

export interface EncryptionScope {
  readonly organisationId: string;
  encrypt(plaintext: string, binding: FieldBinding): Promise<EncryptedFieldV2>;
  decrypt(field: EncryptedField, binding: FieldBinding): Promise<string>;
}

/**
 * Encrypt and decrypt for one organisation.
 *
 * The organisation id is the only selector. The key ARN, version and status
 * come from `organisation_keys`. Encrypt and decrypt take a field binding,
 * never a key id, so a call site cannot aim this scope at another tenant's key.
 */
export async function scopeFor(
  organisationId: string,
  options: ScopeOptions = {},
): Promise<EncryptionScope> {
  const row = await getOrganisationKey(organisationId);
  if (!row) throw new TenantKeyUnavailableError(organisationId, 503);
  return openScope(
    {
      organisationId: row.organisationId,
      kmsKeyArn: row.kmsKeyArn,
      keyVersion: row.keyVersion,
      status: row.status,
    },
    {
      ...options,
      purpose: options.purpose ?? 'field',
      onUnavailable: async (kmsError) => {
        await options.onUnavailable?.(kmsError);
        await markOrganisationKeyUnavailable(organisationId, kmsError);
      },
    },
  );
}

/**
 * Platform-owned ciphertext uses `PLATFORM_KMS_KEY_ARN`, not a tenant key and
 * not `ENCRYPTION_MASTER_KEY`.
 */
export function platformScope(options: ScopeOptions = {}): EncryptionScope {
  const arn = env.PLATFORM_KMS_KEY_ARN;
  if (!arn && isProduction()) {
    throw new Error('PLATFORM_KMS_KEY_ARN is required in production');
  }
  return openScope(
    {
      organisationId: PLATFORM_ORGANISATION_ID,
      kmsKeyArn: arn || LOCAL_PLATFORM_ARN,
      keyVersion: 1,
      status: 'active',
    },
    { ...options, purpose: 'platform' },
  );
}

function httpStatusFor(status: TenantKeyMaterial['status']): 423 | 503 | null {
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

function openScope(material: TenantKeyMaterial, options: ScopeOptions): EncryptionScope {
  const purpose = options.purpose ?? 'field';
  const provider = options.provider ?? createKeyProvider();
  const cache = options.cache ?? sharedDekCache();
  const context: EncryptionContext = {
    org_id: material.organisationId,
    purpose,
  };

  function assertUsable(): void {
    const httpStatus = httpStatusFor(material.status);
    if (httpStatus !== null) {
      throw new TenantKeyUnavailableError(material.organisationId, httpStatus);
    }
  }

  async function unwrap(wrapped: Buffer): Promise<Buffer> {
    const cacheId = dekCacheKey(material.kmsKeyArn, context, wrapped);
    const cached = cache.get(cacheId);
    if (cached) return cached;
    try {
      const dek = Buffer.from(
        await provider.decrypt({
          keyArn: material.kmsKeyArn,
          ciphertextBlob: wrapped,
          encryptionContext: context,
        }),
      );
      cache.set(cacheId, dek, material.organisationId);
      return dek;
    } catch (error) {
      const access = asKmsKeyAccessError(error);
      if (!access) throw error;
      cache.evictOrganisation(material.organisationId);
      try {
        await options.onUnavailable?.(access.kmsError);
      } catch (markError) {
        logger.error({ err: markError }, 'failed to mark tenant key unavailable');
      }
      throw new TenantKeyUnavailableError(material.organisationId, 503);
    }
  }

  return {
    organisationId: material.organisationId,
    async encrypt(plaintext, binding) {
      assertUsable();
      const generated = await provider
        .generateDataKey({
          keyArn: material.kmsKeyArn,
          encryptionContext: context,
        })
        .catch(async (error: unknown) => {
          const access = asKmsKeyAccessError(error);
          if (!access) throw error;
          cache.evictOrganisation(material.organisationId);
          try {
            await options.onUnavailable?.(access.kmsError);
          } catch (markError) {
            logger.error({ err: markError }, 'failed to mark tenant key unavailable');
          }
          throw new TenantKeyUnavailableError(material.organisationId, 503);
        });
      const dek = Buffer.from(generated.plaintext);
      generated.plaintext.fill(0);
      try {
        const sealed = sealField(
          plaintext,
          dek,
          fieldAad(binding, material.organisationId),
        );
        cache.set(
          dekCacheKey(material.kmsKeyArn, context, generated.ciphertextBlob),
          dek,
          material.organisationId,
        );
        return {
          v: ENVELOPE_VERSION,
          kid: kidFor(material.kmsKeyArn, material.keyVersion),
          ctx: context,
          iv: sealed.iv,
          tag: sealed.tag,
          wrappedDek: generated.ciphertextBlob.toString('base64'),
          ciphertext: sealed.ciphertext,
        };
      } finally {
        dek.fill(0);
      }
    },
    async decrypt(field, binding) {
      assertUsable();
      // Version 1 has no tenant binding. It is readable only while the tenant
      // key is active, and only so a migration can copy it into version 2.
      if (!isEnvelopeV2(field)) return decryptFieldV1(field);
      if (field.ctx.org_id !== material.organisationId || field.ctx.purpose !== purpose) {
        throw new Error('Ciphertext does not belong to this organisation');
      }
      const kid = parseKid(field.kid);
      if (kid.arn !== material.kmsKeyArn) {
        throw new Error('Ciphertext does not belong to this organisation');
      }
      const dek = await unwrap(Buffer.from(field.wrappedDek, 'base64'));
      try {
        return openField(field, dek, fieldAad(binding, material.organisationId));
      } finally {
        dek.fill(0);
      }
    },
  };
}
