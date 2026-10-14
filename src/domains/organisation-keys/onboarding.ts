import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  getOrganisationKey,
  registerOrganisationKey,
  resetOrganisationKeyForValidation,
  toPublicOrganisationKey,
  type KeyCustodyMode,
  validateOrganisationKey,
  type PublicOrganisationKey,
} from './service';

export interface SubmitOrganisationKeyInput {
  readonly kmsKeyArn: string;
  readonly custodyMode: KeyCustodyMode;
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

  const row = await validateOrganisationKey(ctx.organisationId, input.kmsKeyArn);
  return toPublicOrganisationKey(row);
}
