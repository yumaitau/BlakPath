import { and, eq, ne } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import { organisationKeys } from '@/db/schema';
import { recordPlatformAudit } from '@/domains/audit';
import { parseKeyArn } from '@/lib/encryption/key-provider';

export type OrganisationKeyRow = typeof organisationKeys.$inferSelect;

export type KeyCustodyMode = OrganisationKeyRow['custodyMode'];
export type OrganisationKeyStatus = OrganisationKeyRow['status'];

const AUDIT_ALLOW = [
  'organisationId',
  'custodyMode',
  'keyVersion',
  'status',
  'escrow',
  'escrowConsentReference',
  'escrowPackageDigest',
  'kmsKeyArn',
] as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface RegisterOrganisationKeyInput {
  readonly organisationId: string;
  readonly custodyMode: KeyCustodyMode;
  readonly kmsKeyArn: string;
}

/**
 * A human-recorded escrow opt-in. The consent is signed by the client's
 * authorised signatories outside BlakPath; only its reference is stored.
 */
export interface RecordEscrowOptInInput {
  readonly organisationId: string;
  readonly consentReference: string;
  readonly consentedAt: Date;
  /** SHA-256 (hex) of the deposited escrow-package.json. */
  readonly packageDigest: string;
  /** Staff user who recorded the opt-in. */
  readonly recordedByUserId: string;
}

function auditSnapshot(row: OrganisationKeyRow): Record<string, unknown> {
  return {
    organisationId: row.organisationId,
    custodyMode: row.custodyMode,
    keyVersion: row.keyVersion,
    status: row.status,
    escrow: row.escrow,
    escrowConsentReference: row.escrowConsentReference,
    escrowPackageDigest: row.escrowPackageDigest,
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
 * Insert the organisation's current key and append a platform-chain event.
 * Escrow starts off; it is recorded after the deposit by {@link recordEscrowOptIn}.
 */
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
      escrow: false,
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
 * Point the organisation at a new CMK ARN and bump the key version.
 * Escrow is cleared: the deposited package holds the replaced key material.
 * A new ceremony and opt-in are needed to escrow the new key.
 */
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
      escrow: false,
      escrowPackageDigest: null,
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

/**
 * Record a client's escrow opt-in with its signed consent reference.
 *
 * Only `client_owned_escrow` keys qualify: their material was generated in a
 * key ceremony and imported (Origin=EXTERNAL). AWS-generated KMS material
 * cannot be exported, so it cannot be escrowed.
 */
export async function recordEscrowOptIn(
  input: RecordEscrowOptInInput,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  const consentReference = input.consentReference.trim();
  if (!consentReference) throw new Error('Escrow opt-in requires a consent reference');
  if (Number.isNaN(input.consentedAt.getTime())) {
    throw new Error('Escrow opt-in requires the consent signing date');
  }
  const packageDigest = input.packageDigest.toLowerCase();
  if (!SHA256_HEX.test(packageDigest)) {
    throw new Error('Escrow package digest must be a SHA-256 hex digest');
  }
  const current = await getOrganisationKey(input.organisationId, database);
  if (!current) throw new Error('Organisation has no key');
  if (current.custodyMode !== 'client_owned_escrow') {
    throw new Error(
      'Escrow requires imported key material (custody mode client_owned_escrow)',
    );
  }
  const updated = await database
    .update(organisationKeys)
    .set({
      escrow: true,
      escrowConsentReference: consentReference,
      escrowConsentedAt: input.consentedAt,
      escrowPackageDigest: packageDigest,
    })
    .where(eq(organisationKeys.organisationId, input.organisationId))
    .returning();
  const row = updated[0];
  if (!row) throw new Error('Failed to record escrow opt-in');
  await recordPlatformAudit({
    action: 'key.escrow_opted_in',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: 'success',
    actorUserId: input.recordedByUserId,
    after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
  });
  return row;
}

/**
 * Record that the client withdrew from escrow. The consent reference stays
 * for history. The vault package stays inert until its Object Lock retention
 * ends; the runbook pairs withdrawal with a rotation to un-escrowed material.
 */
export async function withdrawEscrow(
  organisationId: string,
  recordedByUserId: string,
  reason: string,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  const updated = await database
    .update(organisationKeys)
    .set({ escrow: false, escrowPackageDigest: null })
    .where(eq(organisationKeys.organisationId, organisationId))
    .returning();
  const row = updated[0];
  if (!row) throw new Error('Organisation has no key');
  await recordPlatformAudit({
    action: 'key.escrow_withdrawn',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: 'success',
    reason,
    actorUserId: recordedByUserId,
    after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
  });
  return row;
}
