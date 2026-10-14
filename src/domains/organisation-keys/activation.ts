import { eq } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import { organisations } from '@/db/schema';
import { recordAudit } from '@/domains/audit';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { requireTenantContext } from '@/lib/tenancy/context';
import { getOrganisationKey, type OrganisationKeyRow } from './service';

/**
 * An organisation must not become `active` until its key has passed the
 * handshake and is still usable. Non-production seed and pilot bootstrap do
 * not use this function.
 */
export class OrganisationActivationError extends Error {
  readonly code = 'KEY_NOT_VALIDATED' as const;
  readonly status = 409;

  constructor() {
    super('Organisation cannot become active');
    this.name = 'OrganisationActivationError';
  }
}

export function keyAllowsActivation(
  key: Pick<OrganisationKeyRow, 'status' | 'validationStatus'> | null,
): boolean {
  return key?.status === 'active' && key.validationStatus === 'passed';
}

export async function activateOrganisation(
  organisationId: string,
  database: Database = db,
): Promise<{ id: string; status: 'active' }> {
  const key = await getOrganisationKey(organisationId, database);
  if (!keyAllowsActivation(key)) throw new OrganisationActivationError();

  const updated = await database
    .update(organisations)
    .set({ status: 'active' })
    .where(eq(organisations.id, organisationId))
    .returning({ id: organisations.id, status: organisations.status });
  const row = updated[0];
  if (!row || row.status !== 'active') throw new OrganisationActivationError();

  await recordAudit({
    action: 'admin.organisation_updated',
    resourceType: 'organisation',
    resourceId: row.id,
    result: 'success',
    reason: 'activated',
    organisationId,
    after: { data: { status: 'active' }, allow: ['status'] },
  });
  return { id: row.id, status: 'active' };
}

/** Org admin, after step-up, asks for the current tenant to become active. */
export async function activateCurrentOrganisation(): Promise<{
  id: string;
  status: 'active';
}> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  return activateOrganisation(ctx.organisationId);
}
