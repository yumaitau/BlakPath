import { desc, eq, isNull } from 'drizzle-orm';
import { familyLinks } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { getApplication } from '@/domains/applications';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  assertDifferentActor,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import {
  decideFamilyLinkSchema,
  requestFamilyLinkSchema,
  type DecideFamilyLinkInput,
  type RequestFamilyLinkInput,
} from './schemas';
import { canDecide, canWithdraw, type FamilyLinkStatus } from './status';

/**
 * Family-links service — tenant-scoped, permission-checked, audited.
 *
 * Recording a link needs `family-link:request`; approving/disputing needs
 * `family-link:approve`. SEPARATION OF DUTIES is enforced structurally: the
 * person who approves or disputes a link can never be the person who requested
 * it (`assertDifferentActor`). None of this determines Aboriginality — it
 * records and confirms a specific relationship.
 */

export type FamilyLinkRow = typeof familyLinks.$inferSelect;

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${what} to be returned from the database.`);
  }
  return row;
}

/** Load a live family link within the active tenant scope. */
async function loadLink(id: string): Promise<FamilyLinkRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(familyLinks)
    .where(
      scope.where(
        familyLinks.organisationId,
        eq(familyLinks.id, id),
        isNull(familyLinks.deletedAt),
      ),
    )
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

/** Request that a family connection be recorded for an application. */
export async function requestFamilyLink(
  applicationId: string,
  rawInput: RequestFamilyLinkInput,
): Promise<FamilyLinkRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'family-link:request');

  const input = requestFamilyLinkSchema.parse(rawInput);
  // Enforce readability of the application (audits the view).
  await getApplication(applicationId);

  const scope = currentScope();
  const inserted = await scope.db
    .insert(familyLinks)
    .values(
      scope.insertValues({
        applicationId,
        requestedByUserId: ctx.userId,
        relationship: input.relationship,
        relativeName: input.relativeName,
        community: input.community ?? null,
        notes: input.notes ?? null,
        status: 'requested',
      }),
    )
    .returning();
  const row = must(inserted[0], 'family link');

  await recordAudit({
    action: 'family_link.created',
    resourceType: 'family_link',
    resourceId: row.id,
    result: 'success',
    after: {
      data: { applicationId, relationship: input.relationship },
      allow: ['applicationId', 'relationship'],
    },
  });

  return row;
}

/** Shared approve/dispute path. `next` is the resulting decided status. */
async function decideLink(
  linkId: string,
  next: 'approved' | 'disputed',
  rawInput: DecideFamilyLinkInput,
): Promise<FamilyLinkRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'family-link:approve');

  const input = decideFamilyLinkSchema.parse(rawInput);
  const link = await loadLink(linkId);
  if (!link) throw new AuthorizationError('POLICY_DENIED');
  if (!canDecide(link.status as FamilyLinkStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This link is already decided.');
  }
  // Separation of duties: the decider must not be the requester.
  assertDifferentActor(ctx.userId, link.requestedByUserId);

  const scope = currentScope();
  const updated = await scope.db
    .update(familyLinks)
    .set({
      status: next,
      decidedByUserId: ctx.userId,
      decidedAt: new Date(),
      decisionNote: input.note ?? null,
    })
    .where(scope.where(familyLinks.organisationId, eq(familyLinks.id, linkId)))
    .returning();
  const row = must(updated[0], 'family link');

  await recordAudit({
    action: next === 'approved' ? 'family_link.confirmed' : 'family_link.disputed',
    resourceType: 'family_link',
    resourceId: linkId,
    result: 'success',
    reason: input.note ? 'family_link.decision_note' : null,
    before: { data: { status: 'requested' }, allow: ['status'] },
    after: { data: { status: next }, allow: ['status'] },
  });

  return row;
}

/** Approve a requested family link (approver must differ from the requester). */
export async function approveFamilyLink(
  linkId: string,
  rawInput: DecideFamilyLinkInput = {},
): Promise<FamilyLinkRow> {
  return decideLink(linkId, 'approved', rawInput);
}

/** Dispute a requested family link (decider must differ from the requester). */
export async function disputeFamilyLink(
  linkId: string,
  rawInput: DecideFamilyLinkInput = {},
): Promise<FamilyLinkRow> {
  return decideLink(linkId, 'disputed', rawInput);
}

/** Withdraw a link the actor requested, before it is decided. */
export async function withdrawFamilyLink(linkId: string): Promise<FamilyLinkRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'family-link:request');

  const link = await loadLink(linkId);
  if (!link) throw new AuthorizationError('POLICY_DENIED');
  if (
    link.requestedByUserId !== ctx.userId ||
    !canWithdraw(link.status as FamilyLinkStatus)
  ) {
    throw new AuthorizationError('POLICY_DENIED');
  }

  const scope = currentScope();
  const updated = await scope.db
    .update(familyLinks)
    .set({ status: 'withdrawn' })
    .where(scope.where(familyLinks.organisationId, eq(familyLinks.id, linkId)))
    .returning();
  const row = must(updated[0], 'family link');

  await recordAudit({
    action: 'family_link.removed',
    resourceType: 'family_link',
    resourceId: linkId,
    result: 'success',
  });

  return row;
}

/** List family links for an application the actor may read. */
export async function listFamilyLinks(applicationId: string): Promise<FamilyLinkRow[]> {
  // Enforces the application read policy and audits the view.
  await getApplication(applicationId);

  const scope = currentScope();
  return scope.db
    .select()
    .from(familyLinks)
    .where(
      scope.where(
        familyLinks.organisationId,
        eq(familyLinks.applicationId, applicationId),
        isNull(familyLinks.deletedAt),
      ),
    )
    .orderBy(desc(familyLinks.createdAt));
}
