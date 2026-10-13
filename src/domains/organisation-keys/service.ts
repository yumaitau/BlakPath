import { and, eq, ne } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import { organisationKeyRewraps, organisationKeys } from '@/db/schema';
import { recordPlatformAudit } from '@/domains/audit';
import { sharedDekCache } from '@/lib/encryption/dek-cache';
import { parseKeyArn } from '@/lib/encryption/key-provider';
import { replacementRequired } from '@/lib/encryption/rewrap';

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
  'previousKmsKeyArn',
  'rewrapId',
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
    previousKmsKeyArn: row.previousKmsKeyArn,
  };
}

export interface KeyReplacement {
  readonly key: OrganisationKeyRow;
  readonly rewrapId: string;
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

/**
 * Point the organisation at a replacement CMK and open a re-wrap job.
 *
 * The previous ARN stays on the row so existing ciphertext still opens until
 * the job finishes. The same ARN is KMS automatic rotation and does not start
 * a job. Call `enqueueKeyRewrap` (or `replaceOrganisationKey`) to run it.
 */
export async function rotateOrganisationKey(
  organisationId: string,
  kmsKeyArn: string,
  database: Database = db,
): Promise<KeyReplacement> {
  parseKeyArn(kmsKeyArn);
  const current = await getOrganisationKey(organisationId, database);
  if (!current) throw new Error('Organisation has no key to rotate');
  if (!replacementRequired(current.kmsKeyArn, kmsKeyArn)) {
    throw new Error(
      'KMS automatic rotation keeps the same key ARN and does not start a re-wrap',
    );
  }
  if (current.status !== 'active') {
    throw new Error('Refusing to replace a key that is not active');
  }
  if (current.previousKmsKeyArn) {
    throw new Error('A key replacement is already in progress');
  }
  const nextVersion = current.keyVersion + 1;
  const updated = await database
    .update(organisationKeys)
    .set({
      kmsKeyArn,
      keyVersion: nextVersion,
      previousKmsKeyArn: current.kmsKeyArn,
      previousKeyVersion: current.keyVersion,
      rotatedAt: new Date(),
      status: 'active',
    })
    .where(eq(organisationKeys.organisationId, organisationId))
    .returning();
  const row = updated[0];
  if (!row) throw new Error('Failed to rotate organisation key');
  const inserted = await database
    .insert(organisationKeyRewraps)
    .values({
      organisationId,
      fromKmsKeyArn: current.kmsKeyArn,
      fromKeyVersion: current.keyVersion,
      toKmsKeyArn: kmsKeyArn,
      toKeyVersion: nextVersion,
      status: 'running',
      phase: 'fields',
    })
    .returning();
  const rewrap = inserted[0];
  if (!rewrap) throw new Error('Failed to record key re-wrap');
  await recordPlatformAudit({
    action: 'key.replacement_started',
    resourceType: 'organisation_key_rewrap',
    resourceId: rewrap.id,
    result: 'success',
    after: {
      data: { ...auditSnapshot(row), rewrapId: rewrap.id },
      allow: AUDIT_ALLOW,
    },
  });
  return { key: row, rewrapId: rewrap.id };
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
  if (status !== 'active') sharedDekCache().evictOrganisation(organisationId);
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
