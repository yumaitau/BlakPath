import { and, eq, ne } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import { organisationKeyRewraps, organisationKeys } from '@/db/schema';
import { recordPlatformAudit, type AuditTransaction } from '@/domains/audit';
import { assertCodedAuditReason } from '@/domains/audit/hash';
import { sharedDekCache } from '@/lib/encryption/dek-cache';
import {
  runKeyHandshake,
  withLocalKeyPolicy,
  type KeyValidationFailureCode,
} from '@/lib/encryption/key-handshake';
import { parseKeyArn, type KeyProvider } from '@/lib/encryption/key-provider';
import { KmsKeyProvider } from '@/lib/encryption/kms-provider';
import { createKeyProvider, DEV_TENANT_KEY_ARN } from '@/lib/encryption/provider';
import { replacementRequired } from '@/lib/encryption/rewrap';
import { env, isProduction } from '@/lib/env';

export type OrganisationKeyRow = typeof organisationKeys.$inferSelect;

export type KeyCustodyMode = OrganisationKeyRow['custodyMode'];
export type OrganisationKeyStatus = OrganisationKeyRow['status'];

const SHA256_HEX = /^[0-9a-f]{64}$/;

const AUDIT_ALLOW = [
  'organisationId',
  'custodyMode',
  'keyVersion',
  'status',
  'validationStatus',
  'escrow',
  'escrowConsentReference',
  'escrowPackageDigest',
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
    escrowConsentReference: row.escrowConsentReference,
    escrowPackageDigest: row.escrowPackageDigest,
    kmsKeyArn: row.kmsKeyArn,
  };
}

/** KMS KeyState values. Anything else from KMS is reported as `other`. */
const KMS_KEY_STATES: ReadonlySet<string> = new Set([
  'Creating',
  'Enabled',
  'Disabled',
  'PendingDeletion',
  'PendingImport',
  'PendingReplicaDeletion',
  'Unavailable',
  'Updating',
]);
const KMS_EXCEPTION_NAME = /^[A-Za-z]{1,64}Exception$/;

/**
 * Reduce a KMS error name or key state to a closed vocabulary before it
 * reaches the audit chain. Free text (messages, ARNs, request ids) becomes
 * `other` so nothing unvetted is hashed into the trail.
 */
export function auditableKmsSignal(value: string | null | undefined): string {
  if (!value) return 'other';
  if (KMS_KEY_STATES.has(value) || KMS_EXCEPTION_NAME.test(value)) return value;
  return 'other';
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

/**
 * Register a key when the organisation has none, then run the handshake so a
 * passing key is active.
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
  await validateOrganisationKey(organisationId, kmsKeyArn, database);
}

/**
 * Run the handshake against the registered key and record the result. Only a
 * pass makes the key active.
 */
export async function validateOrganisationKey(
  organisationId: string,
  kmsKeyArn: string,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  const handshake = await runKeyHandshake(handshakeProvider(organisationId), {
    keyArn: kmsKeyArn,
    orgId: organisationId,
  });
  const row = await completeOrganisationKeyValidation(
    {
      organisationId,
      failureCode: handshake.ok ? null : handshake.code,
      canaryCiphertext: handshake.ok
        ? handshake.canaryCiphertext.toString('base64')
        : null,
    },
    database,
  );
  if (handshake.ok) handshake.canaryCiphertext.fill(0);
  return row;
}

/**
 * Provider for the key handshake. Local development has no key policy, so the
 * local provider is wrapped in one that refuses any other org_id.
 */
export function handshakeProvider(organisationId: string): KeyProvider {
  const provider = createKeyProvider();
  if (provider instanceof KmsKeyProvider) return provider;
  return withLocalKeyPolicy(provider, organisationId);
}

/** Insert the organisation's current key and append a platform-chain event. */
export async function registerOrganisationKey(
  input: RegisterOrganisationKeyInput,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  assertTenantKeyArn(input.kmsKeyArn);
  return database.transaction(async (tx) => {
    const inserted = await tx
      .insert(organisationKeys)
      .values({
        organisationId: input.organisationId,
        custodyMode: input.custodyMode,
        kmsKeyArn: input.kmsKeyArn,
        keyVersion: 1,
        status: 'pending_validation',
        validationStatus: 'pending',
        escrow: input.escrow ?? false,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('Failed to register organisation key');
    await recordPlatformAudit(
      {
        action: 'key.registered',
        resourceType: 'organisation_key',
        resourceId: row.id,
        result: 'success',
        after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
      },
      tx,
    );
    return row;
  });
}

export interface KeyReplacement {
  readonly key: OrganisationKeyRow;
  readonly rewrapId: string;
}

/**
 * Point the organisation at a replacement CMK and open a re-wrap job.
 *
 * The previous ARN stays on the row so existing ciphertext still opens until
 * the job finishes. The same ARN is KMS automatic rotation and does not start
 * a job. The row stays `active` so the tenant is not locked, and the handshake
 * fields reset so the new CMK is validated again.
 */
export async function rotateOrganisationKey(
  organisationId: string,
  kmsKeyArn: string,
  database: Database = db,
): Promise<KeyReplacement> {
  assertTenantKeyArn(kmsKeyArn);
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
  return database.transaction(async (tx) => {
    const updated = await tx
      .update(organisationKeys)
      .set({
        kmsKeyArn,
        keyVersion: nextVersion,
        previousKmsKeyArn: current.kmsKeyArn,
        previousKeyVersion: current.keyVersion,
        rotatedAt: new Date(),
        status: 'active',
        validationStatus: 'pending',
        validatedAt: null,
        validationFailure: null,
        canaryCiphertext: null,
        escrow: false,
        escrowPackageDigest: null,
      })
      .where(eq(organisationKeys.organisationId, organisationId))
      .returning();
    const row = updated[0];
    if (!row) throw new Error('Failed to rotate organisation key');
    const inserted = await tx
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
    await recordPlatformAudit(
      {
        action: 'key.replacement_started',
        resourceType: 'organisation_key_rewrap',
        resourceId: rewrap.id,
        result: 'success',
        after: {
          data: { ...auditSnapshot(row), rewrapId: rewrap.id },
          allow: [...AUDIT_ALLOW, 'rewrapId'],
        },
      },
      tx,
    );
    return { key: row, rewrapId: rewrap.id };
  });
}

/**
 * Write a status change and its audit on `tx`. The caller owns the
 * transaction and must evict cached data keys after it commits.
 */
export async function applyOrganisationKeyStatus(
  tx: AuditTransaction,
  organisationId: string,
  status: OrganisationKeyStatus,
): Promise<OrganisationKeyRow> {
  const updated = await tx
    .update(organisationKeys)
    .set({ status })
    .where(eq(organisationKeys.organisationId, organisationId))
    .returning();
  const changed = updated[0];
  if (!changed) throw new Error('Organisation has no key');
  await recordPlatformAudit(
    {
      action: 'key.status_changed',
      resourceType: 'organisation_key',
      resourceId: changed.id,
      result: 'success',
      after: { data: auditSnapshot(changed), allow: AUDIT_ALLOW },
    },
    tx,
  );
  return changed;
}

/** Human status change (disable, schedule deletion, re-enable). */
export async function setOrganisationKeyStatus(
  organisationId: string,
  status: OrganisationKeyStatus,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  const row = await database.transaction((tx) =>
    applyOrganisationKeyStatus(tx, organisationId, status),
  );
  // Evict after commit so a concurrent read cannot re-cache under the old status.
  if (status !== 'active') sharedDekCache().evictOrganisation(organisationId);
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
  await database.transaction(async (tx) => {
    const updated = await tx
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
    await recordPlatformAudit(
      {
        action: 'key.unavailable',
        resourceType: 'organisation_key',
        resourceId: row.id,
        result: 'failure',
        reason: 'key.kms_refused',
        after: {
          data: { ...auditSnapshot(row), kmsError: auditableKmsSignal(kmsError) },
          allow: [...AUDIT_ALLOW, 'kmsError'],
        },
      },
      tx,
    );
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
  return database.transaction(async (tx) => {
    const updated = await tx
      .update(organisationKeys)
      .set({
        custodyMode: input.custodyMode,
        kmsKeyArn: input.kmsKeyArn,
        keyVersion: current.keyVersion + 1,
        status: 'pending_validation',
        validationStatus: 'pending',
        escrow: input.escrow ?? false,
        validatedAt: null,
        validationFailure: null,
        canaryCiphertext: null,
        rotatedAt: new Date(),
      })
      .where(eq(organisationKeys.organisationId, input.organisationId))
      .returning();
    const row = updated[0];
    if (!row) throw new Error('Failed to reset organisation key');
    await recordPlatformAudit(
      {
        action: 'key.rotated',
        resourceType: 'organisation_key',
        resourceId: row.id,
        result: 'success',
        after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
      },
      tx,
    );
    return row;
  });
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
  return database.transaction(async (tx) => {
    const updated = await tx
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
    await recordPlatformAudit(
      {
        action: passed ? 'key.validation_passed' : 'key.validation_failed',
        resourceType: 'organisation_key',
        resourceId: row.id,
        result: passed ? 'success' : 'failure',
        ...(input.failureCode ? { reason: input.failureCode } : {}),
        after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
      },
      tx,
    );
    return row;
  });
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
  await database.transaction(async (tx) => {
    const updated = await tx
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
    await recordPlatformAudit(
      {
        action: input.status === 'unavailable' ? 'key.unavailable' : 'key.status_changed',
        resourceType: 'organisation_key',
        resourceId: row.id,
        result: input.status === 'active' ? 'success' : 'failure',
        reason: input.status === 'active' ? 'key.health_ok' : 'key.health_degraded',
        after: {
          data: {
            ...auditSnapshot(row),
            healthState: auditableKmsSignal(input.healthState),
          },
          allow: [...AUDIT_ALLOW, 'healthState'],
        },
      },
      tx,
    );
  });
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
  return database.transaction(async (tx) => {
    const updated = await tx
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
    await recordPlatformAudit(
      {
        action: 'key.escrow_opted_in',
        resourceType: 'organisation_key',
        resourceId: row.id,
        result: 'success',
        actorUserId: input.recordedByUserId,
        after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
      },
      tx,
    );
    return row;
  });
}

/**
 * Record that the client withdrew from escrow. `reason` is a coded value such
 * as `escrow.client_notice`; the written notice
 * itself is kept outside the audit chain. The consent reference stays
 * for history. The vault package stays inert until its Object Lock retention
 * ends; the runbook pairs withdrawal with a rotation to un-escrowed material.
 */
export async function withdrawEscrow(
  organisationId: string,
  recordedByUserId: string,
  reason: string,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  // Reject free text before the write, so a bad reason cannot leave escrow
  // withdrawn without its audit event.
  assertCodedAuditReason(reason);
  return database.transaction(async (tx) => {
    const updated = await tx
      .update(organisationKeys)
      .set({ escrow: false, escrowPackageDigest: null })
      .where(eq(organisationKeys.organisationId, organisationId))
      .returning();
    const row = updated[0];
    if (!row) throw new Error('Organisation has no key');
    await recordPlatformAudit(
      {
        action: 'key.escrow_withdrawn',
        resourceType: 'organisation_key',
        resourceId: row.id,
        result: 'success',
        reason,
        actorUserId: recordedByUserId,
        after: { data: auditSnapshot(row), allow: AUDIT_ALLOW },
      },
      tx,
    );
    return row;
  });
}
