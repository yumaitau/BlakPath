import { KmsKeyProvider } from '@/lib/encryption/kms-provider';
import { runKeyHandshake, withLocalKeyPolicy } from '@/lib/encryption/key-handshake';
import type { KeyProvider } from '@/lib/encryption/key-provider';
import { createKeyProvider } from '@/lib/encryption/provider';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  completeOrganisationKeyValidation,
  getOrganisationKey,
  registerOrganisationKey,
  resetOrganisationKeyForValidation,
  toPublicOrganisationKey,
  type KeyCustodyMode,
  type PublicOrganisationKey,
} from './service';

export interface SubmitOrganisationKeyInput {
  readonly kmsKeyArn: string;
  readonly custodyMode: KeyCustodyMode;
}

function providerForHandshake(orgId: string): KeyProvider {
  const provider = createKeyProvider();
  if (provider instanceof KmsKeyProvider) return provider;
  return withLocalKeyPolicy(provider, orgId);
}

/** Current key for the signed-in admin. Null when none is registered. */
export async function getCurrentOrganisationKey(): Promise<PublicOrganisationKey | null> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const row = await getOrganisationKey(ctx.organisationId);
  return row ? toPublicOrganisationKey(row) : null;
}

/**
 * Register a CMK ARN and run the handshake. The caller has already stepped up.
 * The key stays unusable until both the round trip and the wrong-context
 * negative test succeed.
 */
export async function submitOrganisationKey(
  input: SubmitOrganisationKeyInput,
): Promise<PublicOrganisationKey> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const existing = await getOrganisationKey(ctx.organisationId);
  if (existing) {
    await resetOrganisationKeyForValidation({
      organisationId: ctx.organisationId,
      custodyMode: input.custodyMode,
      kmsKeyArn: input.kmsKeyArn,
    });
  } else {
    await registerOrganisationKey({
      organisationId: ctx.organisationId,
      custodyMode: input.custodyMode,
      kmsKeyArn: input.kmsKeyArn,
    });
  }

  const handshake = await runKeyHandshake(providerForHandshake(ctx.organisationId), {
    keyArn: input.kmsKeyArn,
    orgId: ctx.organisationId,
  });
  const row = await completeOrganisationKeyValidation({
    organisationId: ctx.organisationId,
    failureCode: handshake.ok ? null : handshake.code,
    canaryCiphertext: handshake.ok ? handshake.canaryCiphertext.toString('base64') : null,
  });
  if (handshake.ok) handshake.canaryCiphertext.fill(0);
  return toPublicOrganisationKey(row);
}
