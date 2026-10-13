import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditEvents, users } from '@/db/schema';
import { recordAudit } from '@/domains/audit';
import { parseKeyArn } from '@/lib/encryption/key-provider';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { isAuthorizationError } from '@/lib/permissions/errors';
import { requireTenantContext } from '@/lib/tenancy/context';
import { checkOrganisationKeyHealth, type KeyHealthResult } from './health';
import {
  cloudTrailLinks,
  escrowView,
  toHistoryEntries,
  type CloudTrailLinks,
  type EscrowView,
  type KeyHistoryEntry,
} from './presentation';
import {
  getOrganisationKey,
  setOrganisationKeyStatus,
  type KeyCustodyMode,
  type OrganisationKeyStatus,
} from './service';

/**
 * "Your keys" — the organisation administrator's view of its own key.
 *
 * Every function here runs inside a verified tenant context and requires
 * `tenant:configure`. The organisation id comes from that context, never from
 * the request, so an administrator only ever sees and checks their own key.
 * A view is recorded on the tenant chain; checks and status changes are
 * recorded on the platform chain beside the other key events.
 */

const HISTORY_LIMIT = 50;

export interface KeyCustodyOverview {
  readonly organisationId: string;
  readonly custodyMode: KeyCustodyMode;
  readonly kmsKeyArn: string;
  readonly keyAccountId: string;
  readonly keyRegion: string;
  readonly keyVersion: number;
  readonly status: OrganisationKeyStatus;
  readonly registeredAt: Date;
  readonly rotatedAt: Date | null;
  readonly lastHealthCheck: {
    readonly at: Date;
    readonly ok: boolean;
    readonly detail: string | null;
  } | null;
  readonly escrow: EscrowView;
  readonly cloudTrail: CloudTrailLinks;
  readonly history: readonly KeyHistoryEntry[];
}

function assertConfigure(): ReturnType<typeof requireTenantContext> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  return ctx;
}

async function recordDeniedView(error: unknown): Promise<void> {
  if (!isAuthorizationError(error)) return;
  await recordAudit({
    action: 'key.viewed',
    resourceType: 'organisation_key',
    result: 'denied',
    reason: error.code,
  });
}

async function keyEvents(keyRowId: string, action?: 'key.health_checked') {
  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      timestamp: auditEvents.timestamp,
      result: auditEvents.result,
      reason: auditEvents.reason,
      actorName: users.name,
      afterMeta: auditEvents.afterMeta,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.actorUserId, users.id))
    .where(
      and(
        isNull(auditEvents.organisationId),
        eq(auditEvents.resourceType, 'organisation_key'),
        eq(auditEvents.resourceId, keyRowId),
        action ? eq(auditEvents.action, action) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
    .limit(action ? 1 : HISTORY_LIMIT);
}

/**
 * Current key, last health check, escrow status and change history. Returns
 * null when no tenant key has been registered yet. The view is audited.
 */
export async function getKeyCustodyOverview(): Promise<KeyCustodyOverview | null> {
  let ctx: ReturnType<typeof requireTenantContext>;
  try {
    ctx = assertConfigure();
  } catch (error) {
    await recordDeniedView(error);
    throw error;
  }
  const row = await getOrganisationKey(ctx.organisationId);
  await recordAudit({
    action: 'key.viewed',
    resourceType: 'organisation_key',
    resourceId: row?.id ?? null,
    result: 'success',
  });
  if (!row) return null;

  const [events, lastCheck] = await Promise.all([
    keyEvents(row.id),
    keyEvents(row.id, 'key.health_checked'),
  ]);
  const check = lastCheck[0];
  const { accountId, region } = parseKeyArn(row.kmsKeyArn);
  return {
    organisationId: row.organisationId,
    custodyMode: row.custodyMode,
    kmsKeyArn: row.kmsKeyArn,
    keyAccountId: accountId,
    keyRegion: region,
    keyVersion: row.keyVersion,
    status: row.status,
    registeredAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    lastHealthCheck: check
      ? { at: check.timestamp, ok: check.result === 'success', detail: check.reason }
      : null,
    escrow: escrowView(row),
    cloudTrail: cloudTrailLinks(row.kmsKeyArn, row.organisationId, row.custodyMode),
    history: toHistoryEntries(events),
  };
}

export interface KeyHealthCheckOutcome extends KeyHealthResult {
  /** True when a passing check returned an `unavailable` key to `active`. */
  readonly restored: boolean;
}

/**
 * Run a health check on the caller's own organisation key.
 *
 * With `restore`, a passing check returns an `unavailable` key to `active`.
 * That is the only status an administrator can lift here: `disabled` and
 * `pending_deletion` are deliberate custody decisions and are not undone by a
 * successful KMS call.
 */
export async function runKeyHealthCheck(
  options: { readonly restore?: boolean } = {},
): Promise<KeyHealthCheckOutcome> {
  const ctx = assertConfigure();
  const result = await checkOrganisationKeyHealth(ctx.organisationId);
  if (!options.restore || !result.ok) return { ...result, restored: false };
  const row = await getOrganisationKey(ctx.organisationId);
  if (row?.status !== 'unavailable') return { ...result, restored: false };
  await setOrganisationKeyStatus(ctx.organisationId, 'active');
  return { ...result, restored: true };
}
