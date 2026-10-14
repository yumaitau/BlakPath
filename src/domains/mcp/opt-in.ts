import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { aiGovernanceApprovals, featureFlags } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { requireTenantContext } from '@/lib/tenancy/context';
import { AI_FEATURES_FLAG, assertAiFeatureChange } from './policy';

/**
 * Tenant opt-in for external tool access.
 *
 * `aiFeatures` stays off until an organisation administrator, after step-up,
 * records a governance approval and sets the flag. The endpoint reads both.
 */

const setAiFeaturesSchema = z
  .object({
    enabled: z.boolean(),
    governanceReference: z.string().trim().min(1).max(200).optional(),
    governanceStatement: z.string().trim().min(1).max(2000).optional(),
  })
  .superRefine((value, context) => {
    if (!value.enabled) return;
    if (!value.governanceReference) {
      context.addIssue({
        code: 'custom',
        path: ['governanceReference'],
        message: 'Governance reference is required to enable AI features.',
      });
    }
    if (!value.governanceStatement) {
      context.addIssue({
        code: 'custom',
        path: ['governanceStatement'],
        message: 'Governance statement is required to enable AI features.',
      });
    }
  });

export interface TenantAiFeaturesStatus {
  readonly enabled: boolean;
  readonly governanceRecorded: boolean;
}

async function readStatus(): Promise<TenantAiFeaturesStatus> {
  const scope = currentScope();
  const [flag, approval] = await Promise.all([
    scope.db
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(
        scope.where(featureFlags.organisationId, eq(featureFlags.key, AI_FEATURES_FLAG)),
      )
      .limit(1),
    scope.db
      .select({ id: aiGovernanceApprovals.id })
      .from(aiGovernanceApprovals)
      .where(scope.where(aiGovernanceApprovals.organisationId))
      .limit(1),
  ]);
  return {
    enabled: flag[0]?.enabled === true,
    governanceRecorded: approval.length > 0,
  };
}

/** True only when the tenant flag is on and a governance approval is stored. */
export async function tenantAiOptedIn(): Promise<boolean> {
  const status = await readStatus();
  return status.enabled && status.governanceRecorded;
}

/** Current opt-in, for an organisation administrator. */
export async function getTenantAiFeatures(): Promise<TenantAiFeaturesStatus> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  return readStatus();
}

/**
 * Turn tenant AI features on or off.
 *
 * `stepUpVerified` must be set by the route only after `requireRecentAuth`
 * succeeds. Callers cannot supply it in the JSON body.
 */
export async function setTenantAiFeatures(
  raw: unknown,
  stepUpVerified: boolean,
): Promise<TenantAiFeaturesStatus> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const input = setAiFeaturesSchema.parse(raw);
  assertAiFeatureChange({
    enabled: input.enabled,
    stepUpVerified,
    governanceReference: input.governanceReference ?? null,
    governanceStatement: input.governanceStatement ?? null,
  });

  const scope = currentScope();
  await scope.db.transaction(async (tx) => {
    if (input.enabled) {
      await tx.insert(aiGovernanceApprovals).values(
        scope.insertValues({
          reference: input.governanceReference as string,
          statement: input.governanceStatement as string,
          approvedByUserId: ctx.userId,
          stepUpVerified: true,
        }),
      );
    }
    await tx
      .insert(featureFlags)
      .values(
        scope.insertValues({
          key: AI_FEATURES_FLAG,
          enabled: input.enabled,
        }),
      )
      .onConflictDoUpdate({
        target: [featureFlags.organisationId, featureFlags.key],
        set: { enabled: input.enabled, updatedAt: new Date() },
      });
  });

  await recordAudit({
    action: 'admin.feature_flag_changed',
    resourceType: 'feature_flag',
    resourceId: AI_FEATURES_FLAG,
    result: 'success',
    reason: input.enabled ? (input.governanceReference ?? null) : 'disabled',
    after: {
      data: {
        key: AI_FEATURES_FLAG,
        enabled: input.enabled,
        governanceReference: input.governanceReference ?? null,
        stepUpVerified: true,
      },
      allow: ['key', 'enabled', 'governanceReference', 'stepUpVerified'],
    },
  });

  return readStatus();
}
