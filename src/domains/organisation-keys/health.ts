import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { platformDb } from '@/db/platform-db';
import { scopeFor } from '@/db/tenant-db';
import { recordPlatformAudit } from '@/domains/audit';
import { membershipRoles, memberships, organisationKeys, roles } from '@/db/schema';
import { createNotification } from '@/domains/notifications';
import { KEY_VALIDATION_PURPOSE } from '@/lib/encryption/key-handshake';
import {
  asKmsKeyAccessError,
  type KeyProvider,
  type KmsAccessErrorName,
} from '@/lib/encryption/key-provider';
import { KmsKeyProvider } from '@/lib/encryption/kms-provider';
import { createKeyProvider } from '@/lib/encryption/provider';
import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email/mailer';
import { logger } from '@/lib/observability/logger';
import { sharedDekCache, type DekCache } from '@/lib/encryption/dek-cache';
import {
  probeKeyProvider,
  runKeyHealth,
  type KeyHealthResult,
} from '@/lib/encryption/key-health';
import {
  getOrganisationKey,
  markOrganisationKeyUnavailable,
  saveKeyHealthObservation,
  setOrganisationKeyStatus,
  type OrganisationKeyStatus,
} from './service';

const ADMIN_SLUG = 'organisation-admin';

export interface DescribedKey {
  readonly keyState: string;
  readonly enabled: boolean;
}

export interface KeyHealthProbe {
  describeKey(keyArn: string): Promise<DescribedKey>;
  decrypt(input: {
    readonly keyArn: string;
    readonly ciphertextBlob: Buffer;
    readonly encryptionContext: { readonly org_id: string; readonly purpose: string };
  }): Promise<Buffer>;
}

export interface KeyHealthSubject {
  readonly organisationId: string;
  readonly kmsKeyArn: string;
  readonly status: OrganisationKeyStatus;
  readonly validationStatus: 'pending' | 'passed' | 'failed';
  readonly canaryCiphertext: string | null;
  readonly lastHealthState: string | null;
}

export interface KeyHealthAlert {
  readonly organisationId: string;
  readonly correlationId: string;
  readonly previousState: string | null;
  readonly healthState: string;
  readonly status: OrganisationKeyStatus;
}

export interface KeyHealthDeps {
  load(organisationId: string): Promise<KeyHealthSubject | null>;
  save(input: {
    organisationId: string;
    status: OrganisationKeyStatus;
    healthState: string;
    previousStatus: OrganisationKeyStatus;
  }): Promise<void>;
  probe: KeyHealthProbe;
  notifyAdmins(alert: KeyHealthAlert): Promise<void>;
  notifyOnCall(alert: KeyHealthAlert): Promise<void>;
}

export interface KeyHealthDecision {
  readonly status: OrganisationKeyStatus;
  readonly healthState: string;
}

/** Map DescribeKey, and a canary decrypt when the key still claims to be on. */
export function decideKeyHealth(input: {
  readonly described: DescribedKey;
  readonly decryptFailure: string | null;
}): KeyHealthDecision {
  if (!input.described.enabled || input.described.keyState !== 'Enabled') {
    return {
      status: statusForKeyState(input.described.keyState),
      healthState: input.described.keyState,
    };
  }
  if (input.decryptFailure) {
    return {
      status: input.decryptFailure === 'DisabledException' ? 'disabled' : 'unavailable',
      healthState: input.decryptFailure,
    };
  }
  return { status: 'active', healthState: 'Enabled' };
}

function statusForKeyState(keyState: string): OrganisationKeyStatus {
  if (keyState === 'Disabled') return 'disabled';
  if (keyState === 'PendingDeletion' || keyState === 'PendingReplicaDeletion') {
    return 'pending_deletion';
  }
  return 'unavailable';
}

/**
 * Alert on a real transition. The first healthy observation is silent so a
 * worker restart does not page on-call for a key that is fine.
 */
export function shouldAlertKeyHealth(previous: string | null, next: string): boolean {
  if (previous === next) return false;
  if (previous === null && next === 'Enabled') return false;
  return true;
}

export interface KeyHealthOutcome {
  readonly checked: boolean;
  readonly alerted: boolean;
  readonly healthState: string | null;
}

export async function runKeyHealthCheck(
  deps: KeyHealthDeps,
  input: { readonly organisationId: string; readonly correlationId: string },
): Promise<KeyHealthOutcome> {
  const subject = await deps.load(input.organisationId);
  if (!subject || subject.validationStatus !== 'passed') {
    return { checked: false, alerted: false, healthState: null };
  }

  let described: DescribedKey;
  try {
    described = await deps.probe.describeKey(subject.kmsKeyArn);
  } catch (error) {
    const access = asKmsKeyAccessError(error);
    if (!access) throw error;
    described = { keyState: access.kmsError, enabled: false };
  }

  let decryptFailure: string | null = null;
  if (described.enabled && described.keyState === 'Enabled') {
    decryptFailure = await canaryFailure(deps.probe, subject);
  }
  const decision = decideKeyHealth({ described, decryptFailure });
  const alerted = shouldAlertKeyHealth(subject.lastHealthState, decision.healthState);
  if (alerted) {
    const alert: KeyHealthAlert = {
      organisationId: subject.organisationId,
      correlationId: input.correlationId,
      previousState: subject.lastHealthState,
      healthState: decision.healthState,
      status: decision.status,
    };
    await deps.notifyAdmins(alert);
    await deps.notifyOnCall(alert);
  }
  await deps.save({
    organisationId: subject.organisationId,
    status: decision.status,
    healthState: decision.healthState,
    previousStatus: subject.status,
  });
  return { checked: true, alerted, healthState: decision.healthState };
}

async function canaryFailure(
  probe: KeyHealthProbe,
  subject: KeyHealthSubject,
): Promise<string | null> {
  if (!subject.canaryCiphertext) return 'CanaryMissing';
  try {
    const dek = await probe.decrypt({
      keyArn: subject.kmsKeyArn,
      ciphertextBlob: Buffer.from(subject.canaryCiphertext, 'base64'),
      encryptionContext: {
        org_id: subject.organisationId,
        purpose: KEY_VALIDATION_PURPOSE,
      },
    });
    dek.fill(0);
    return null;
  } catch (error) {
    const access = asKmsKeyAccessError(error);
    if (!access) throw error;
    return access.kmsError;
  }
}

async function listOrganisationAdminUserIds(organisationId: string): Promise<string[]> {
  const rows = await scopeFor(organisationId)
    .db.select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(
      and(
        eq(memberships.organisationId, organisationId),
        eq(memberships.status, 'active'),
        eq(roles.slug, ADMIN_SLUG),
      ),
    );
  return [...new Set(rows.map((row) => row.userId))];
}

function probeFrom(provider: KeyProvider): KeyHealthProbe {
  return {
    describeKey(keyArn) {
      if (provider instanceof KmsKeyProvider) return provider.describeKey(keyArn);
      return Promise.resolve({ keyState: 'Enabled', enabled: true });
    },
    decrypt(input) {
      return provider.decrypt(input);
    },
  };
}

async function notifyTenantAdmins(alert: KeyHealthAlert): Promise<void> {
  const userIds = await listOrganisationAdminUserIds(alert.organisationId);
  const title = 'Encryption key needs a custodian';
  const body = `The encryption key changed from ${alert.previousState ?? 'unknown'} to ${alert.healthState}. Records stay locked until a key custodian restores it.`;
  await Promise.all(
    userIds.map((userId) =>
      createNotification(
        {
          organisationId: alert.organisationId,
          userId,
          type: 'key.health',
          title,
          body,
          resourceType: 'organisation_key',
        },
        alert.correlationId,
      ),
    ),
  );
}

async function notifyOperatorOnCall(alert: KeyHealthAlert): Promise<void> {
  logger.error(
    {
      signal: 'key_health_state_change',
      alert: true,
      organisationId: alert.organisationId,
      previousState: alert.previousState,
      keyState: alert.healthState,
    },
    'tenant key health changed',
  );
  const to = env.OPERATOR_ONCALL_EMAIL;
  if (!to) return;
  await sendEmail({
    to,
    subject: 'BlakPath tenant key health changed',
    text: `Organisation ${alert.organisationId} key state changed from ${alert.previousState ?? 'unknown'} to ${alert.healthState}. Records for that organisation stay locked until the key is usable again.`,
  });
}

/** Worker entry. One tenant, one DescribeKey, one canary decrypt. */
export async function checkTenantKeyHealth(input: {
  readonly organisationId: string;
  readonly correlationId: string;
}): Promise<KeyHealthOutcome> {
  return runKeyHealthCheck(
    {
      async load(organisationId) {
        const rows = await scopeFor(organisationId)
          .db.select({
            organisationId: organisationKeys.organisationId,
            kmsKeyArn: organisationKeys.kmsKeyArn,
            status: organisationKeys.status,
            validationStatus: organisationKeys.validationStatus,
            canaryCiphertext: organisationKeys.canaryCiphertext,
            lastHealthState: organisationKeys.lastHealthState,
          })
          .from(organisationKeys)
          .where(eq(organisationKeys.organisationId, organisationId))
          .limit(1);
        return rows[0] ?? null;
      },
      save: saveKeyHealthObservation,
      probe: probeFrom(createKeyProvider()),
      notifyAdmins: notifyTenantAdmins,
      notifyOnCall: notifyOperatorOnCall,
    },
    input,
  );
}

/**
 * Probe every registered tenant key. A revoked grant pauses that tenant.
 * A key that answers again after `unavailable` is set back to `active` and
 * the caller resumes its jobs. Other tenants are separate subjects.
 */
export async function sweepOrganisationKeyHealth(
  options: {
    database?: Database;
    provider?: KeyProvider;
    cache?: DekCache;
    pause?: (organisationId: string) => Promise<void>;
    resume?: (organisationId: string) => Promise<void>;
  } = {},
): Promise<KeyHealthResult[]> {
  // Cross-tenant sweep: every tenant's key row, and platform-chain status writes.
  const database = options.database ?? platformDb;
  const provider = options.provider ?? createKeyProvider();
  const cache = options.cache ?? sharedDekCache();
  const rows = await database.select().from(organisationKeys);
  return runKeyHealth({
    subjects: rows.map((row) => ({
      organisationId: row.organisationId,
      kmsKeyArn: row.kmsKeyArn,
      status: row.status,
    })),
    probe: (subject) =>
      probeKeyProvider(provider, subject.kmsKeyArn, subject.organisationId),
    setStatus: async (organisationId, status) => {
      if (status === 'unavailable') {
        await markOrganisationKeyUnavailable(
          organisationId,
          'KMS key access refused',
          database,
        );
        return;
      }
      await setOrganisationKeyStatus(organisationId, 'active', database);
    },
    evict: (organisationId) => cache.evictOrganisation(organisationId),
    pause: options.pause ?? (async () => {}),
    resume: options.resume ?? (async () => {}),
  });
}

export const KEY_HEALTH_PURPOSE = 'key_health';

export type KeyHealthFailure = KmsAccessErrorName | 'no_key' | 'mismatch' | 'error';

export interface OrganisationKeyHealthResult {
  readonly ok: boolean;
  readonly checkedAt: Date;
  readonly failure: KeyHealthFailure | null;
}

export interface OrganisationKeyHealthOptions {
  readonly provider?: KeyProvider;
  readonly database?: Database;
}

/**
 * Wrap a throwaway data key under the organisation's key and unwrap it again.
 * The encryption context purpose is `key_health`, so CloudTrail can tell a
 * settings check from a data operation.
 */
export async function checkOrganisationKeyHealth(
  organisationId: string,
  options: OrganisationKeyHealthOptions = {},
): Promise<OrganisationKeyHealthResult> {
  const row = await getOrganisationKey(
    organisationId,
    options.database ?? scopeFor(organisationId).db,
  );
  if (!row) return { ok: false, checkedAt: new Date(), failure: 'no_key' };

  const provider = options.provider ?? createKeyProvider();
  const context = {
    org_id: row.organisationId,
    purpose: KEY_HEALTH_PURPOSE,
  } as const;
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
      // Platform-chain audit with the key row, so the platform handle.
      await markOrganisationKeyUnavailable(
        organisationId,
        access.kmsError,
        options.database ?? platformDb,
      );
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
