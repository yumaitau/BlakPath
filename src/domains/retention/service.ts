import { desc, eq, isNull } from 'drizzle-orm';
import {
  applications,
  destructionRegister,
  disposalAuthoritySignoffs,
  evidence,
  formResponses,
  legalHolds,
  retentionPolicies,
} from '@/db/schema';
import { currentScope, type TenantScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { toCsv } from '@/domains/reporting/csv';
import {
  assertDifferentActor,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { addJob, QueueName } from '@/lib/queues';
import { requireTenantContext } from '@/lib/tenancy/context';
import { activationBlockReason } from './approval';
import {
  CATALOGUE_VERSION,
  DISPOSAL_CLASS_INFO,
  disposalCatalogue,
  disposalClassFor,
  type DisposalCatalogue,
} from './disposal';
import { RetentionError } from './errors';
import { DESTRUCTION_REGISTER_COLUMNS, destructionRegisterRows } from './register';
import {
  createPolicySchema,
  placeHoldSchema,
  signDisposalAuthoritySchema,
  type CreatePolicyInput,
  type PlaceHoldInput,
  type SignDisposalAuthorityInput,
} from './schemas';
import { previewRetentionSweep, type RetentionPreviewItem } from './sweep';
import type { SweepResourceType } from './rules';

/**
 * Retention management — tenant-scoped, permission-checked, audited.
 *
 * All operations require `retention:manage`. A policy is drafted inactive.
 * A different person activates it. A purge also needs a current disposal
 * authority signed by a records manager. The sweep runs out-of-band (see
 * sweep.ts). `queueRetentionSweep` enqueues a sweep for a tenant (a scheduler
 * calls it periodically — issue #14).
 *
 * PRODUCT INVARIANT: this records human decisions about record lifecycle. It
 * never scores or determines Aboriginality.
 */

export type RetentionPolicyRow = typeof retentionPolicies.$inferSelect;
export type LegalHoldRow = typeof legalHolds.$inferSelect;
export type DisposalAuthoritySignoffRow = typeof disposalAuthoritySignoffs.$inferSelect;
export type DestructionRegisterRow = typeof destructionRegister.$inferSelect;

/** The hold target is not a row in this tenant. */
export class RetentionTargetError extends Error {
  readonly code = 'RETENTION_TARGET_MISSING';
  readonly status = 404;
  constructor() {
    super('Legal hold target does not exist.');
    this.name = 'RetentionTargetError';
  }
}

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

async function currentSignoff(
  scope: TenantScope,
  jurisdiction: string,
  disposalClass: string,
): Promise<DisposalAuthoritySignoffRow | null> {
  const rows = await scope.db
    .select()
    .from(disposalAuthoritySignoffs)
    .where(
      scope.where(
        disposalAuthoritySignoffs.organisationId,
        eq(disposalAuthoritySignoffs.jurisdiction, jurisdiction),
        eq(disposalAuthoritySignoffs.disposalClass, disposalClass),
        eq(disposalAuthoritySignoffs.catalogueVersion, CATALOGUE_VERSION),
        isNull(disposalAuthoritySignoffs.supersededAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function assertPurgeAllowed(
  signoff: DisposalAuthoritySignoffRow | null,
  authorityReference: string,
  retentionDays: number,
  disposalClass: keyof typeof DISPOSAL_CLASS_INFO,
): void {
  if (DISPOSAL_CLASS_INFO[disposalClass].destructionForbidden) {
    throw new RetentionError('CLASS_FORBIDDEN', 'This record class cannot be destroyed.');
  }
  if (!signoff) {
    throw new RetentionError(
      'SIGN_OFF_REQUIRED',
      'A records manager must sign the disposal authority for this class before a purge can be scheduled.',
    );
  }
  if (signoff.permanent) {
    throw new RetentionError(
      'PERMANENT_CLASS',
      'The signed disposal authority keeps this class permanently.',
    );
  }
  if (signoff.authorityReference !== authorityReference) {
    throw new RetentionError(
      'AUTHORITY_REQUIRED',
      'The authority reference must match the records manager sign-off.',
    );
  }
  if (
    signoff.minimumRetentionDays != null &&
    retentionDays < signoff.minimumRetentionDays
  ) {
    throw new RetentionError(
      'BELOW_SIGNED_MINIMUM',
      'The retention period is shorter than the signed disposal authority allows.',
    );
  }
}

export async function createPolicy(
  rawInput: CreatePolicyInput,
): Promise<RetentionPolicyRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');

  const input = createPolicySchema.parse(rawInput);
  const disposalClass = disposalClassFor(input.resourceType);
  const retentionDays = input.action === 'retain' ? null : (input.retentionDays ?? null);
  const authorityReference = input.authorityReference ?? null;

  if (input.action === 'purge') {
    if (!authorityReference || retentionDays == null) {
      throw new RetentionError(
        'AUTHORITY_REQUIRED',
        'A purge needs a finite retention period and a disposal authority reference.',
      );
    }
    const scope = currentScope();
    const signoff = await currentSignoff(scope, input.jurisdiction, disposalClass);
    assertPurgeAllowed(signoff, authorityReference, retentionDays, disposalClass);
  }

  const scope = currentScope();
  const inserted = await scope.db
    .insert(retentionPolicies)
    .values(
      scope.insertValues({
        resourceType: input.resourceType,
        disposalClass,
        jurisdiction: input.jurisdiction,
        retentionDays,
        action: input.action,
        disposalAuthorityRef: authorityReference,
        active: false,
        createdByUserId: ctx.userId,
      }),
    )
    .returning();
  const row = must(inserted[0], 'retention policy');

  await recordAudit({
    action: 'retention.policy_drafted',
    resourceType: 'retention_policy',
    resourceId: row.id,
    result: 'success',
    after: {
      data: {
        resourceType: input.resourceType,
        disposalClass,
        jurisdiction: input.jurisdiction,
        retentionDays,
        action: input.action,
        hasDisposalAuthority: authorityReference !== null,
      },
      allow: [
        'resourceType',
        'disposalClass',
        'jurisdiction',
        'retentionDays',
        'action',
        'hasDisposalAuthority',
      ],
    },
  });
  return row;
}

export async function activatePolicy(id: string): Promise<RetentionPolicyRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');

  const scope = currentScope();
  const existing = await scope.db
    .select()
    .from(retentionPolicies)
    .where(
      scope.where(
        retentionPolicies.organisationId,
        eq(retentionPolicies.id, id),
        isNull(retentionPolicies.deletedAt),
      ),
    )
    .limit(1);
  const policy = scope.assertOwned(existing[0]) ?? null;
  if (!policy) throw new AuthorizationError('POLICY_DENIED');

  const block = activationBlockReason({
    creatorUserId: policy.createdByUserId,
    approverUserId: ctx.userId,
    alreadyActive: policy.active,
  });
  if (block === 'already_active') {
    throw new RetentionError('ALREADY_ACTIVE', 'This policy is already active.');
  }
  if (block === 'same_actor') {
    assertDifferentActor(ctx.userId, policy.createdByUserId);
  }

  if (policy.action === 'purge') {
    const authorityReference = policy.disposalAuthorityRef?.trim() ?? '';
    if (!policy.disposalClass || !policy.jurisdiction || policy.retentionDays == null) {
      throw new RetentionError(
        'AUTHORITY_REQUIRED',
        'A purge needs a finite retention period and a disposal authority reference.',
      );
    }
    if (authorityReference.length === 0) {
      throw new RetentionError(
        'AUTHORITY_REQUIRED',
        'A purge requires a disposal authority reference.',
      );
    }
    const signoff = await currentSignoff(
      scope,
      policy.jurisdiction,
      policy.disposalClass,
    );
    if (policy.disposalClass in DISPOSAL_CLASS_INFO) {
      assertPurgeAllowed(
        signoff,
        authorityReference,
        policy.retentionDays,
        policy.disposalClass as keyof typeof DISPOSAL_CLASS_INFO,
      );
    } else {
      throw new RetentionError(
        'CLASS_FORBIDDEN',
        'This record class cannot be destroyed.',
      );
    }
  }

  const updated = await scope.db
    .update(retentionPolicies)
    .set({
      active: true,
      approvedByUserId: ctx.userId,
      approvedAt: new Date(),
    })
    .where(
      scope.where(
        retentionPolicies.organisationId,
        eq(retentionPolicies.id, id),
        eq(retentionPolicies.active, false),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) throw new AuthorizationError('POLICY_DENIED');

  await recordAudit({
    action: 'retention.policy_activated',
    resourceType: 'retention_policy',
    resourceId: row.id,
    result: 'success',
    after: {
      data: {
        action: row.action,
        hasDisposalAuthority: (row.disposalAuthorityRef?.trim() ?? '') !== '',
        approvedByUserId: ctx.userId,
      },
      allow: ['action', 'hasDisposalAuthority', 'approvedByUserId'],
    },
  });
  return row;
}

export function listDisposalCatalogue(): DisposalCatalogue {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  return disposalCatalogue();
}

export async function signDisposalAuthority(
  rawInput: SignDisposalAuthorityInput,
): Promise<DisposalAuthoritySignoffRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');

  const input = signDisposalAuthoritySchema.parse(rawInput);
  const scope = currentScope();
  const signedOffAt = new Date();
  const row = await scope.db.transaction(async (tx) => {
    await tx
      .update(disposalAuthoritySignoffs)
      .set({ supersededAt: signedOffAt })
      .where(
        scope.where(
          disposalAuthoritySignoffs.organisationId,
          eq(disposalAuthoritySignoffs.jurisdiction, input.jurisdiction),
          eq(disposalAuthoritySignoffs.disposalClass, input.disposalClass),
          isNull(disposalAuthoritySignoffs.supersededAt),
        ),
      );
    const inserted = await tx
      .insert(disposalAuthoritySignoffs)
      .values(
        scope.insertValues({
          jurisdiction: input.jurisdiction,
          disposalClass: input.disposalClass,
          catalogueVersion: CATALOGUE_VERSION,
          authorityReference: input.authorityReference,
          permanent: input.permanent,
          minimumRetentionDays: input.permanent
            ? null
            : (input.minimumRetentionDays ?? null),
          notes: input.notes ?? null,
          signedOffByUserId: ctx.userId,
          signedOffAt,
        }),
      )
      .returning();
    return must(inserted[0], 'disposal authority sign-off');
  });

  await recordAudit({
    action: 'retention.authority_signed',
    resourceType: 'disposal_authority',
    resourceId: row.id,
    result: 'success',
    after: {
      data: {
        jurisdiction: input.jurisdiction,
        disposalClass: input.disposalClass,
        permanent: input.permanent,
        catalogueVersion: CATALOGUE_VERSION,
      },
      allow: ['jurisdiction', 'disposalClass', 'permanent', 'catalogueVersion'],
    },
  });
  return row;
}

export async function listDisposalAuthorities(): Promise<DisposalAuthoritySignoffRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  return scope.db
    .select()
    .from(disposalAuthoritySignoffs)
    .where(
      scope.where(
        disposalAuthoritySignoffs.organisationId,
        isNull(disposalAuthoritySignoffs.supersededAt),
      ),
    )
    .orderBy(desc(disposalAuthoritySignoffs.signedOffAt));
}

export async function listPolicies(): Promise<RetentionPolicyRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  return scope.db
    .select()
    .from(retentionPolicies)
    .where(
      scope.where(retentionPolicies.organisationId, isNull(retentionPolicies.deletedAt)),
    )
    .orderBy(desc(retentionPolicies.createdAt));
}

export async function deletePolicy(id: string): Promise<void> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  const updated = await scope.db
    .update(retentionPolicies)
    .set({ active: false, deletedAt: new Date() })
    .where(
      scope.where(
        retentionPolicies.organisationId,
        eq(retentionPolicies.id, id),
        isNull(retentionPolicies.deletedAt),
      ),
    )
    .returning({
      id: retentionPolicies.id,
      resourceType: retentionPolicies.resourceType,
    });
  const row = updated[0];
  if (!row) return;

  await recordAudit({
    action: 'retention.policy_deleted',
    resourceType: 'retention_policy',
    resourceId: row.id,
    result: 'success',
    after: {
      data: { resourceType: row.resourceType },
      allow: ['resourceType'],
    },
  });
}

export async function placeHold(rawInput: PlaceHoldInput): Promise<LegalHoldRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');

  const input = placeHoldSchema.parse(rawInput);
  const scope = currentScope();
  if (!(await retentionTargetExists(scope, input.resourceType, input.resourceId))) {
    throw new RetentionTargetError();
  }
  const inserted = await scope.db
    .insert(legalHolds)
    .values(
      scope.insertValues({
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        reason: input.reason,
        placedByUserId: ctx.userId,
      }),
    )
    .returning();
  const row = must(inserted[0], 'legal hold');

  await recordAudit({
    action: 'retention.hold_placed',
    resourceType: 'retention_policy',
    resourceId: row.id,
    result: 'success',
    after: {
      data: { resourceType: input.resourceType, resourceId: input.resourceId },
      allow: ['resourceType', 'resourceId'],
    },
  });
  return row;
}

export async function releaseHold(id: string): Promise<LegalHoldRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  const updated = await scope.db
    .update(legalHolds)
    .set({ releasedAt: new Date(), releasedByUserId: ctx.userId })
    .where(
      scope.where(
        legalHolds.organisationId,
        eq(legalHolds.id, id),
        isNull(legalHolds.releasedAt),
      ),
    )
    .returning();
  const row = must(updated[0], 'legal hold');

  await recordAudit({
    action: 'retention.hold_released',
    resourceType: 'retention_policy',
    resourceId: id,
    result: 'success',
  });
  return row;
}

export async function listHolds(): Promise<LegalHoldRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  return scope.db
    .select()
    .from(legalHolds)
    .where(scope.where(legalHolds.organisationId))
    .orderBy(desc(legalHolds.createdAt));
}

export async function listDestructionRegister(): Promise<DestructionRegisterRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const scope = currentScope();
  return scope.db
    .select()
    .from(destructionRegister)
    .where(scope.where(destructionRegister.organisationId))
    .orderBy(desc(destructionRegister.destroyedAt));
}

/** CSV of the destruction register. The download is audited. */
export async function exportDestructionRegister(): Promise<string> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  const rows = await listDestructionRegister();
  const csv = toCsv(DESTRUCTION_REGISTER_COLUMNS, destructionRegisterRows(rows));
  await recordAudit({
    action: 'retention.register_exported',
    resourceType: 'destruction_register',
    resourceId: ctx.organisationId,
    result: 'success',
    after: { data: { rows: rows.length }, allow: ['rows'] },
  });
  return csv;
}

/** What the next sweep would do. No rows are written and nothing is audited. */
export async function previewRetention(): Promise<RetentionPreviewItem[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'retention:manage');
  return previewRetentionSweep(ctx.organisationId);
}

async function retentionTargetExists(
  scope: TenantScope,
  resourceType: SweepResourceType,
  resourceId: string,
): Promise<boolean> {
  if (resourceType === 'application') {
    const rows = await scope.db
      .select({ id: applications.id })
      .from(applications)
      .where(scope.where(applications.organisationId, eq(applications.id, resourceId)))
      .limit(1);
    return rows.length > 0;
  }
  if (resourceType === 'evidence') {
    const rows = await scope.db
      .select({ id: evidence.id })
      .from(evidence)
      .where(scope.where(evidence.organisationId, eq(evidence.id, resourceId)))
      .limit(1);
    return rows.length > 0;
  }
  if (resourceType === 'form_response') {
    const rows = await scope.db
      .select({ id: formResponses.id })
      .from(formResponses)
      .where(scope.where(formResponses.organisationId, eq(formResponses.id, resourceId)))
      .limit(1);
    return rows.length > 0;
  }
  return false;
}

/** Enqueue a retention sweep for a tenant (called by a scheduler — issue #14). */
export async function queueRetentionSweep(
  organisationId: string,
  correlationId?: string,
): Promise<void> {
  await addJob(QueueName.Retention, 'sweep', {
    organisationId,
    correlationId: correlationId ?? globalThis.crypto.randomUUID(),
  });
}
