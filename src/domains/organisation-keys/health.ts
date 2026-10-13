import { timingSafeEqual } from 'node:crypto';
import { db, type Database } from '@/db/client';
import { recordPlatformAudit } from '@/domains/audit';
import {
  asKmsKeyAccessError,
  type EncryptionContext,
  type KeyProvider,
  type KmsAccessErrorName,
} from '@/lib/encryption/key-provider';
import { createKeyProvider } from '@/lib/encryption/provider';
import { logger } from '@/lib/observability/logger';
import { getOrganisationKey, markOrganisationKeyUnavailable } from './service';

/**
 * Encryption-context purpose for a key health check. It appears in the
 * client's CloudTrail next to `org_id`, so an auditor can tell a check from a
 * data operation. No field data is wrapped under this purpose.
 */
export const KEY_HEALTH_PURPOSE = 'key_health';

export type KeyHealthFailure = KmsAccessErrorName | 'no_key' | 'mismatch' | 'error';

export interface KeyHealthResult {
  readonly ok: boolean;
  readonly checkedAt: Date;
  readonly failure: KeyHealthFailure | null;
}

export interface KeyHealthOptions {
  readonly provider?: KeyProvider;
  readonly database?: Database;
}

/**
 * Wrap a throwaway data key under the organisation's key and unwrap it again.
 *
 * The key ARN comes only from `organisation_keys` for this organisation, and
 * the encryption context is `{org_id, purpose: key_health}`. A KMS refusal
 * marks the key unavailable, exactly as a refused data operation would. Every
 * check is appended to the platform audit chain.
 */
export async function checkOrganisationKeyHealth(
  organisationId: string,
  options: KeyHealthOptions = {},
): Promise<KeyHealthResult> {
  const database = options.database ?? db;
  const row = await getOrganisationKey(organisationId, database);
  if (!row) return { ok: false, checkedAt: new Date(), failure: 'no_key' };

  const provider = options.provider ?? createKeyProvider();
  const context: EncryptionContext = {
    org_id: row.organisationId,
    purpose: KEY_HEALTH_PURPOSE,
  };
  let failure: KeyHealthFailure | null = null;
  let generated: Buffer | null = null;
  let unwrapped: Buffer | null = null;
  try {
    const out = await provider.generateDataKey({
      keyArn: row.kmsKeyArn,
      encryptionContext: context,
    });
    generated = out.plaintext;
    unwrapped = await provider.decrypt({
      keyArn: row.kmsKeyArn,
      ciphertextBlob: out.ciphertextBlob,
      encryptionContext: context,
    });
    const sameKey = out.keyId === row.kmsKeyArn;
    const sameDek =
      generated.length === unwrapped.length && timingSafeEqual(generated, unwrapped);
    if (!sameKey || !sameDek) failure = 'mismatch';
  } catch (error) {
    const access = asKmsKeyAccessError(error);
    failure = access?.kmsError ?? 'error';
    if (access) {
      await markOrganisationKeyUnavailable(organisationId, access.kmsError, database);
    } else {
      logger.warn({ err: error }, 'tenant key health check failed');
    }
  } finally {
    generated?.fill(0);
    unwrapped?.fill(0);
  }

  const checkedAt = new Date();
  await recordPlatformAudit({
    action: 'key.health_checked',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: failure ? 'failure' : 'success',
    reason: failure,
    after: {
      data: {
        organisationId: row.organisationId,
        keyVersion: row.keyVersion,
        kmsKeyArn: row.kmsKeyArn,
      },
      allow: ['organisationId', 'keyVersion', 'kmsKeyArn'],
    },
  });
  return { ok: failure === null, checkedAt, failure };
}
