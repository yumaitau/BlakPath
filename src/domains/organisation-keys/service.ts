import { and, eq, ne } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import { organisationKeys } from '@/db/schema';
import { recordPlatformAudit } from '@/domains/audit';
import { parseKeyArn } from '@/lib/encryption/key-provider';
import { DEV_TENANT_KEY_ARN } from '@/lib/encryption/provider';
import { env, isProduction } from '@/lib/env';

export type OrganisationKeyRow = typeof organisationKeys.$inferSelect;

export type KeyCustodyMode = OrganisationKeyRow['custodyMode'];
export type OrganisationKeyStatus = OrganisationKeyRow['status'];

const AUDIT_ALLOW = [
  'organisationId',
  'custodyMode',
  'keyVersion',
  'status',
  'escrow',
  'kmsKeyArn',
] as const;

export interface RegisterOrganisationKeyInput {
  readonly organisationId: string;
  readonly custodyMode: KeyCustodyMode;
  readonly kmsKeyArn: string;
  readonly escrow?: boolean;
}

function auditSnapshot(row: OrganisationKeyRow): Record<string, unknown> {
  return {
    organisationId: row.organisationId,
    custodyMode: row.custodyMode,
    keyVersion: row.keyVersion,
    status: row.status,
    escrow: row.escrow,
    kmsKeyArn: row.kmsKeyArn,
  };
}

export async function getOrganisationKey(
  organisationId: string,
  database: Database = db,
): Promise<OrganisationKeyRow | null> {
  const rows = await database
    .select()
    .from(organisationKeys)
    .where(eq(organisationKeys.organisationId, organisationId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Register a key when the organisation has none.
 *
 * Development and CI use the local tenant ARN. Production uses
 * `PLATFORM_KMS_KEY_ARN` only as a bootstrap stand-in for seed and pilot
 * paths that call this helper. Ordinary production org creation does not.
 * When that ARN is unset, the organisation stays without a key and writes
 * fail closed until a per-tenant CMK is registered.
 */
export async function ensureOrganisationKey(
  organisationId: string,
  database: Database = db,
): Promise<void> {
  const existing = await getOrganisationKey(organisationId, database);
  if (existing) return;
  const kmsKeyArn = isProduction() ? env.PLATFORM_KMS_KEY_ARN : DEV_TENANT_KEY_ARN;
  if (!kmsKeyArn) return;
  await registerOrganisationKey(
    { organisationId, custodyMode: 'blakpath_managed', kmsKeyArn },
    database,
  );
}

/** Insert the organisation's current key and append a platform-chain event. */
export async function registerOrganisationKey(
  input: RegisterOrganisationKeyInput,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  parseKeyArn(input.kmsKeyArn);
  const inserted = await database
    .insert(organisationKeys)
    .values({
      organisationId: input.organisationId,
      custodyMode: input.custodyMode,
      kmsKeyArn: input.kmsKeyArn,
      keyVersion: 1,
      status: 'active',
      escrow: input.escrow ?? input.custodyMode === 'client_owned_escrow',
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('Failed to register organisation key');
  await recordPlatformAudit({
    action: 'key.registered',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: 'success',
    after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
  });
  return row;
}

/** Point the organisation at a new CMK ARN and bump the key version. */
export async function rotateOrganisationKey(
  organisationId: string,
  kmsKeyArn: string,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  parseKeyArn(kmsKeyArn);
  const current = await getOrganisationKey(organisationId, database);
  if (!current) throw new Error('Organisation has no key to rotate');
  const updated = await database
    .update(organisationKeys)
    .set({
      kmsKeyArn,
      keyVersion: current.keyVersion + 1,
      rotatedAt: new Date(),
      status: 'active',
    })
    .where(eq(organisationKeys.organisationId, organisationId))
    .returning();
  const row = updated[0];
  if (!row) throw new Error('Failed to rotate organisation key');
  await recordPlatformAudit({
    action: 'key.rotated',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: 'success',
    after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
  });
  return row;
}

/** Human status change (disable, schedule deletion, re-enable). */
export async function setOrganisationKeyStatus(
  organisationId: string,
  status: OrganisationKeyStatus,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  const updated = await database
    .update(organisationKeys)
    .set({ status })
    .where(eq(organisationKeys.organisationId, organisationId))
    .returning();
  const row = updated[0];
  if (!row) throw new Error('Organisation has no key');
  await recordPlatformAudit({
    action: 'key.status_changed',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: 'success',
    after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
  });
  return row;
}

/**
 * KMS AccessDenied / DisabledException / KMSInvalidStateException path.
 * Idempotent: a second failure does not append another platform event.
 */
export async function markOrganisationKeyUnavailable(
  organisationId: string,
  kmsError: string,
  database: Database = db,
): Promise<void> {
  const updated = await database
    .update(organisationKeys)
    .set({ status: 'unavailable' })
    .where(
      and(
        eq(organisationKeys.organisationId, organisationId),
        ne(organisationKeys.status, 'unavailable'),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) return;
  await recordPlatformAudit({
    action: 'key.unavailable',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: 'failure',
    reason: kmsError,
    after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
  });
}
