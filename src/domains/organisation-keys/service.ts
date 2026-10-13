import { and, eq, ne } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import { organisationKeys } from '@/db/schema';
import { recordPlatformAudit } from '@/domains/audit';
import { env } from '@/lib/env';
import type { KeyValidationFailureCode } from '@/lib/encryption/key-handshake';
import { parseKeyArn } from '@/lib/encryption/key-provider';

export type OrganisationKeyRow = typeof organisationKeys.$inferSelect;

export type KeyCustodyMode = OrganisationKeyRow['custodyMode'];
export type OrganisationKeyStatus = OrganisationKeyRow['status'];

const AUDIT_ALLOW = [
  'organisationId',
  'custodyMode',
  'keyVersion',
  'status',
  'validationStatus',
  'escrow',
  'kmsKeyArn',
] as const;

/** Bad ARN or region. Safe to surface as HTTP 400. */
export class OrganisationKeyInputError extends Error {
  readonly status = 400;

  constructor() {
    super('Invalid request');
    this.name = 'OrganisationKeyInputError';
  }
}

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
    validationStatus: row.validationStatus,
    escrow: row.escrow,
    kmsKeyArn: row.kmsKeyArn,
  };
}

/** Reject anything that is not a CMK ARN in this deployment's region. */
export function assertTenantKeyArn(kmsKeyArn: string): void {
  let region: string;
  try {
    region = parseKeyArn(kmsKeyArn).region;
  } catch {
    throw new OrganisationKeyInputError();
  }
  if (region !== env.APP_REGION) throw new OrganisationKeyInputError();
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
  assertTenantKeyArn(input.kmsKeyArn);
  const inserted = await database
    .insert(organisationKeys)
    .values({
      organisationId: input.organisationId,
      custodyMode: input.custodyMode,
      kmsKeyArn: input.kmsKeyArn,
      keyVersion: 1,
      status: 'pending_validation',
      validationStatus: 'pending',
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
  assertTenantKeyArn(kmsKeyArn);
  const current = await getOrganisationKey(organisationId, database);
  if (!current) throw new Error('Organisation has no key to rotate');
  const updated = await database
    .update(organisationKeys)
    .set({
      kmsKeyArn,
      keyVersion: current.keyVersion + 1,
      rotatedAt: new Date(),
      status: 'pending_validation',
      validationStatus: 'pending',
      validatedAt: null,
      validationFailure: null,
      canaryCiphertext: null,
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

export type { KeyValidationFailureCode } from '@/lib/encryption/key-handshake';

/**
 * Point an existing row at a new ARN and clear the previous handshake.
 * First registration goes through `registerOrganisationKey`.
 */
export async function resetOrganisationKeyForValidation(
  input: RegisterOrganisationKeyInput,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  assertTenantKeyArn(input.kmsKeyArn);
  const current = await getOrganisationKey(input.organisationId, database);
  if (!current) return registerOrganisationKey(input, database);
  const updated = await database
    .update(organisationKeys)
    .set({
      custodyMode: input.custodyMode,
      kmsKeyArn: input.kmsKeyArn,
      keyVersion: current.keyVersion + 1,
      status: 'pending_validation',
      validationStatus: 'pending',
      escrow: input.escrow ?? input.custodyMode === 'client_owned_escrow',
      validatedAt: null,
      validationFailure: null,
      canaryCiphertext: null,
      rotatedAt: new Date(),
    })
    .where(eq(organisationKeys.organisationId, input.organisationId))
    .returning();
  const row = updated[0];
  if (!row) throw new Error('Failed to reset organisation key');
  await recordPlatformAudit({
    action: 'key.rotated',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: 'success',
    after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
  });
  return row;
}

/** Persist the handshake. Only a pass marks the key usable. */
export async function completeOrganisationKeyValidation(
  input: {
    readonly organisationId: string;
    readonly failureCode: KeyValidationFailureCode | null;
    readonly canaryCiphertext: string | null;
  },
  database: Database = db,
): Promise<OrganisationKeyRow> {
  const passed = input.failureCode === null;
  const updated = await database
    .update(organisationKeys)
    .set({
      status: passed ? 'active' : 'pending_validation',
      validationStatus: passed ? 'passed' : 'failed',
      validatedAt: passed ? new Date() : null,
      validationFailure: input.failureCode,
      canaryCiphertext: passed ? input.canaryCiphertext : null,
    })
    .where(eq(organisationKeys.organisationId, input.organisationId))
    .returning();
  const row = updated[0];
  if (!row) throw new Error('Organisation has no key');
  await recordPlatformAudit({
    action: passed ? 'key.validation_passed' : 'key.validation_failed',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: passed ? 'success' : 'failure',
    ...(input.failureCode ? { reason: input.failureCode } : {}),
    after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
  });
  return row;
}

export interface PublicOrganisationKey {
  readonly custodyMode: KeyCustodyMode;
  readonly kmsKeyArn: string;
  readonly keyVersion: number;
  readonly status: OrganisationKeyStatus;
  readonly validationStatus: OrganisationKeyRow['validationStatus'];
  readonly validationFailure: string | null;
  readonly validatedAt: Date | null;
  readonly lastHealthAt: Date | null;
  readonly lastHealthState: string | null;
  readonly escrow: boolean;
}

/** Fields an org admin may see. The canary ciphertext stays on the server. */
export function toPublicOrganisationKey(row: OrganisationKeyRow): PublicOrganisationKey {
  return {
    custodyMode: row.custodyMode,
    kmsKeyArn: row.kmsKeyArn,
    keyVersion: row.keyVersion,
    status: row.status,
    validationStatus: row.validationStatus,
    validationFailure: row.validationFailure,
    validatedAt: row.validatedAt,
    lastHealthAt: row.lastHealthAt,
    lastHealthState: row.lastHealthState,
    escrow: row.escrow,
  };
}

/** Health observation. Audits only when the usable status actually changes. */
export async function saveKeyHealthObservation(
  input: {
    readonly organisationId: string;
    readonly status: OrganisationKeyStatus;
    readonly healthState: string;
    readonly previousStatus: OrganisationKeyStatus;
  },
  database: Database = db,
): Promise<void> {
  const updated = await database
    .update(organisationKeys)
    .set({
      status: input.status,
      lastHealthAt: new Date(),
      lastHealthState: input.healthState,
    })
    .where(eq(organisationKeys.organisationId, input.organisationId))
    .returning();
  const row = updated[0];
  if (!row || input.previousStatus === input.status) return;
  await recordPlatformAudit({
    action: input.status === 'unavailable' ? 'key.unavailable' : 'key.status_changed',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: input.status === 'active' ? 'success' : 'failure',
    reason: input.healthState,
    after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
  });
}
