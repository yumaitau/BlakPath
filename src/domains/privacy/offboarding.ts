import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, is, ne, type SQL } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import * as schema from '@/db/schema';
import {
  membershipInvitations,
  membershipRoles,
  memberships,
  organisations,
  tenantOffboardings,
  users,
} from '@/db/schema';
import { recordAudit, recordPlatformAudit } from '@/domains/audit/service';
import type { AuditAction } from '@/domains/audit/events';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { addJob, QueueName, type TenantJob } from '@/lib/queues';
import {
  deleteAllObjectVersions,
  EVIDENCE_BUCKET,
  objectKey,
  presignDownload,
  putObjectBytes,
  QUARANTINE_BUCKET,
} from '@/lib/storage/s3';
import { offboardingConfirmSchema, type OffboardingConfirmInput } from './schemas';
import { columnByName, columnKeys } from './subject';

/**
 * Tenant offboarding — export everything, then purge.
 *
 *   1. An administrator (`tenant:configure`, step-up at the route) confirms by
 *      typing the organisation slug. The worker writes a JSON export of every
 *      tenant-owned row to the tenant's own storage namespace.
 *   2. The administrator downloads the export.
 *   3. Only after a download, the administrator confirms the purge (slug again,
 *      step-up again). The organisation is closed, and the worker deletes every
 *      object version under the tenant prefix in both buckets, then deletes the
 *      organisation row — which cascades to every tenant table.
 *
 * Kept after the purge, by design: the append-only audit trail and its
 * checkpoints (official records with no foreign key to the tenant), the
 * `tenant_offboardings` row itself, and global sign-in identities (`users`),
 * which may belong to other organisations.
 */

export type TenantOffboardingRow = typeof tenantOffboardings.$inferSelect;

export interface OffboardingJob extends TenantJob {
  offboardingId: string;
}

/** Tables that intentionally outlive a tenant purge. */
export const RETAINED_AFTER_PURGE: readonly string[] = [
  'audit_events',
  'audit_integrity_checkpoints',
  'tenant_offboardings',
];

/** Credentials and secrets never written to an export, by SQL column name. */
export const EXPORT_OMITTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  api_keys: ['key_hash'],
  webhook_endpoints: ['secret'],
  form_invitations: ['token_hash'],
  membership_invitations: ['token_hash'],
  organisation_domains: ['verification_token'],
};

const BATCH = 1000;

function allTables(): PgTable[] {
  return (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
}

/** Every table carrying an `organisation_id` column, except the offboarding log. */
export function tenantTables(): PgTable[] {
  return allTables().filter((table) => {
    const config = getTableConfig(table);
    return (
      config.name !== 'tenant_offboardings' &&
      config.columns.some((c) => c.name === 'organisation_id')
    );
  });
}

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

async function loadOrganisation(id: string) {
  const rows = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, id))
    .limit(1);
  return rows[0];
}

async function loadOffboarding(organisationId: string, id: string) {
  const rows = await db
    .select()
    .from(tenantOffboardings)
    .where(
      and(
        eq(tenantOffboardings.organisationId, organisationId),
        eq(tenantOffboardings.id, id),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Request an offboarding export. Requires `tenant:configure` and the org slug. */
export async function requestTenantOffboarding(
  rawInput: OffboardingConfirmInput,
): Promise<TenantOffboardingRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const input = offboardingConfirmSchema.parse(rawInput);
  const org = await loadOrganisation(ctx.organisationId);
  if (!org || org.slug !== input.confirmSlug) {
    throw new AuthorizationError(
      'POLICY_DENIED',
      'Type the organisation slug to confirm.',
    );
  }
  const open = await db
    .select({ id: tenantOffboardings.id })
    .from(tenantOffboardings)
    .where(
      and(
        eq(tenantOffboardings.organisationId, ctx.organisationId),
        ne(tenantOffboardings.status, 'purged'),
      ),
    )
    .limit(1);
  if (open.length > 0) {
    throw new AuthorizationError('POLICY_DENIED', 'An offboarding is already under way.');
  }

  const inserted = await db
    .insert(tenantOffboardings)
    .values({
      organisationId: ctx.organisationId,
      organisationSlug: org.slug,
      requestedByUserId: ctx.userId,
    })
    .returning();
  const row = must(inserted[0], 'tenant offboarding');

  await addJob<OffboardingJob>(
    QueueName.Privacy,
    'offboarding-export',
    {
      organisationId: ctx.organisationId,
      correlationId: ctx.correlationId,
      offboardingId: row.id,
    },
    { jobId: `offboarding-export-${row.id}` },
  );
  await recordAudit({
    action: 'offboarding.requested',
    resourceType: 'tenant_offboarding',
    resourceId: row.id,
    result: 'success',
  });
  return row;
}

/** The tenant's offboarding history. Requires `tenant:configure`. */
export async function listOffboardings(): Promise<TenantOffboardingRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  return db
    .select()
    .from(tenantOffboardings)
    .where(eq(tenantOffboardings.organisationId, ctx.organisationId))
    .orderBy(desc(tenantOffboardings.createdAt));
}

/** Presign the export for download and note that it was fetched. */
export async function getOffboardingExportUrl(
  id: string,
): Promise<{ url: string; expiresIn: number }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const row = await loadOffboarding(ctx.organisationId, id);
  if (!row || row.status !== 'exported' || !row.exportObjectKey) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  const signed = await presignDownload({
    organisationId: ctx.organisationId,
    key: row.exportObjectKey,
    fileName: `${row.organisationSlug}-export.json`,
  });
  await db
    .update(tenantOffboardings)
    .set({ downloadedAt: new Date() })
    .where(eq(tenantOffboardings.id, id));
  await recordAudit({
    action: 'offboarding.downloaded',
    resourceType: 'tenant_offboarding',
    resourceId: id,
    result: 'success',
  });
  return signed;
}

/**
 * Confirm the purge. Only after the export was downloaded, and only with the
 * slug typed again. Closes the organisation and queues the purge.
 */
export async function confirmTenantPurge(
  id: string,
  rawInput: OffboardingConfirmInput,
): Promise<TenantOffboardingRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const input = offboardingConfirmSchema.parse(rawInput);
  const row = await loadOffboarding(ctx.organisationId, id);
  if (!row || row.status !== 'exported' || !row.downloadedAt) {
    throw new AuthorizationError(
      'POLICY_DENIED',
      'Download the export before confirming the purge.',
    );
  }
  if (row.organisationSlug !== input.confirmSlug) {
    throw new AuthorizationError(
      'POLICY_DENIED',
      'Type the organisation slug to confirm.',
    );
  }

  const updated = await db
    .update(tenantOffboardings)
    .set({
      status: 'purge_queued',
      purgeConfirmedByUserId: ctx.userId,
      purgeConfirmedAt: new Date(),
    })
    .where(and(eq(tenantOffboardings.id, id), eq(tenantOffboardings.status, 'exported')))
    .returning();
  const next = must(updated[0], 'tenant offboarding');
  // A closed organisation receives no more scheduled jobs.
  await db
    .update(organisations)
    .set({ status: 'closed' })
    .where(eq(organisations.id, ctx.organisationId));

  await recordAudit({
    action: 'offboarding.purge_confirmed',
    resourceType: 'tenant_offboarding',
    resourceId: id,
    result: 'success',
  });
  await addJob<OffboardingJob>(
    QueueName.Privacy,
    'offboarding-purge',
    {
      organisationId: ctx.organisationId,
      correlationId: ctx.correlationId,
      offboardingId: id,
    },
    { jobId: `offboarding-purge-${id}` },
  );
  return next;
}

function systemAudit(
  input: OffboardingJob,
  action: AuditAction,
  result: 'success' | 'failure' = 'success',
  reason: string | null = null,
) {
  return recordAudit({
    action,
    resourceType: 'tenant_offboarding',
    resourceId: input.offboardingId,
    result,
    reason,
    organisationId: input.organisationId,
    actorUserId: null,
    actingRole: 'system',
    sessionId: null,
    correlationId: input.correlationId,
  });
}

/** All rows of one tenant table, keyset-paged, secrets omitted. */
async function exportTable(table: PgTable, organisationId: string): Promise<unknown[]> {
  const config = getTableConfig(table);
  const org = columnByName(table, 'organisation_id');
  const id = columnByName(table, 'id');
  if (!org || !id) throw new Error(`${config.name} has no organisation_id/id column`);
  const keys = columnKeys(table);
  const omit = (EXPORT_OMITTED_COLUMNS[config.name] ?? []).map((c) => keys.get(c));

  const rows: unknown[] = [];
  let last: string | null = null;
  for (;;) {
    const where: SQL = (
      last === null ? eq(org, organisationId) : and(eq(org, organisationId), gt(id, last))
    ) as SQL;
    const page = (await db
      .select()
      .from(table)
      .where(where)
      .orderBy(asc(id))
      .limit(BATCH)) as Array<Record<string, unknown>>;
    for (const row of page) {
      for (const key of omit) if (key) delete row[key];
      rows.push(row);
    }
    if (page.length < BATCH) break;
    last = String(page[page.length - 1]!.id);
  }
  return rows;
}

/** Worker: write the tenant export. Idempotent per offboarding. */
export async function processOffboardingExport(input: OffboardingJob): Promise<void> {
  const row = await loadOffboarding(input.organisationId, input.offboardingId);
  if (!row || row.exportedAt) return;
  try {
    const org = await loadOrganisation(input.organisationId);
    if (!org) throw new Error('organisation no longer exists');

    const tables: Record<string, unknown[]> = { organisations: [org] };
    for (const table of tenantTables()) {
      tables[getTableConfig(table).name] = await exportTable(table, input.organisationId);
    }
    const memberIds = await db
      .select({ id: memberships.id, userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.organisationId, input.organisationId));
    tables.membership_roles =
      memberIds.length === 0
        ? []
        : await db
            .select()
            .from(membershipRoles)
            .where(
              inArray(
                membershipRoles.membershipId,
                memberIds.map((m) => m.id),
              ),
            );
    tables.users =
      memberIds.length === 0
        ? []
        : await db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(users)
            .where(
              inArray(
                users.id,
                memberIds.map((m) => m.userId),
              ),
            );

    const manifest = Object.fromEntries(
      Object.entries(tables).map(([name, rows]) => [name, rows.length]),
    );
    const body = Buffer.from(
      JSON.stringify({
        format: 'blakpath-tenant-export',
        version: 1,
        organisationId: input.organisationId,
        exportedAt: new Date().toISOString(),
        manifest,
        tables,
      }),
      'utf8',
    );
    const key = objectKey(
      input.organisationId,
      'offboarding',
      `${input.offboardingId}.json`,
    );
    await putObjectBytes({
      bucket: EVIDENCE_BUCKET,
      key,
      body,
      contentType: 'application/json',
    });

    await db
      .update(tenantOffboardings)
      .set({
        status: 'exported',
        exportObjectKey: key,
        exportSha256: createHash('sha256').update(body).digest('hex'),
        exportRowCount: Object.values(manifest).reduce((a, b) => a + b, 0),
        manifest,
        exportedAt: new Date(),
        error: null,
      })
      .where(eq(tenantOffboardings.id, input.offboardingId));
    await systemAudit(input, 'offboarding.exported');
  } catch (error) {
    await markFailed(input, 'export failed');
    throw error;
  }
}

/** Worker: purge objects then rows. Only runs once a human confirmed it. */
export async function processOffboardingPurge(input: OffboardingJob): Promise<void> {
  const row = await loadOffboarding(input.organisationId, input.offboardingId);
  if (!row || row.purgedAt || !row.purgeConfirmedAt || !row.downloadedAt) return;
  try {
    const prefix = `${objectKey(input.organisationId)}/`;
    let versions = 0;
    for (const bucket of [EVIDENCE_BUCKET, QUARANTINE_BUCKET]) {
      versions += await deleteAllObjectVersions({ bucket, prefix });
    }

    await db.transaction(async (tx) => {
      // Invitations hold a RESTRICT reference to (tenant) roles; clear them first
      // so the cascade from the organisation row cannot trip over it.
      await tx
        .delete(membershipInvitations)
        .where(eq(membershipInvitations.organisationId, input.organisationId));
      await tx.delete(organisations).where(eq(organisations.id, input.organisationId));
      await tx
        .update(tenantOffboardings)
        .set({ status: 'purged', purgedAt: new Date(), error: null })
        .where(eq(tenantOffboardings.id, input.offboardingId));
    });

    await recordPlatformAudit({
      action: 'offboarding.purged',
      resourceType: 'tenant_offboarding',
      resourceId: input.offboardingId,
      result: 'success',
      reason: `tenant ${row.organisationSlug} purged; ${versions} object version(s) deleted`,
      actorUserId: null,
      actingRole: 'system',
      sessionId: null,
      correlationId: input.correlationId,
    });
  } catch (error) {
    await markFailed(input, 'purge failed');
    throw error;
  }
}

/** Record a failure without row content; the job retries from where it stopped. */
async function markFailed(input: OffboardingJob, message: string): Promise<void> {
  await db
    .update(tenantOffboardings)
    .set({ error: message })
    .where(eq(tenantOffboardings.id, input.offboardingId));
  await systemAudit(input, 'offboarding.failed', 'failure', message);
}
