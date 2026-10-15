import { desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { familyLinks } from '@/db/schema';
import {
  openFamilyRows,
  sealFamilyDecisionNote,
  sealFamilyFields,
} from '@/lib/encryption/tenant-fields';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit } from '@/domains/audit/service';
import { getApplication } from '@/domains/applications';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  assertDifferentActor,
  hasAny,
  requirePermission,
  subjectFromContext,
  type Subject,
} from '@/lib/permissions/check';
import type { Permission } from '@/lib/permissions/catalog';
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
 * it (`assertDifferentActor`). A refusal is audited. None of this determines
 * Aboriginality — it records and confirms a specific relationship.
 *
 * Genealogy is culturally sensitive. Reading links needs a family-link
 * permission AND a staff read of the case (`application:read-any` or
 * `application:read-assigned`), so an applicant never reads the register.
 *
 * `relative_name`, `community`, `notes`, and `decision_note` sit under the
 * tenant key. Callers receive plaintext only after a successful open.
 */

export type FamilyLinkRow = typeof familyLinks.$inferSelect;

/** Decrypted family link returned to routes and the case page. */
export interface FamilyLinkRecord {
  id: string;
  applicationId: string;
  requestedByUserId: string | null;
  relationship: string;
  relativeName: string;
  community: string | null;
  notes: string | null;
  relativeDeceased: boolean;
  status: FamilyLinkStatus;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

const FAMILY_LINK_PERMISSIONS = [
  'family-link:request',
  'family-link:approve',
] as const satisfies readonly Permission[];

const STAFF_CASE_READ = [
  'application:read-any',
  'application:read-assigned',
] as const satisfies readonly Permission[];

/** Whether the subject may read family links (genealogy role and staff case read). */
export function canReadFamilyLinks(subject: Subject): boolean {
  return hasAny(subject, FAMILY_LINK_PERMISSIONS) && hasAny(subject, STAFF_CASE_READ);
}

/** Project an opened row to the fields routes and the case page may show. */
function presentFamilyLink(row: FamilyLinkRow): FamilyLinkRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    requestedByUserId: row.requestedByUserId,
    relationship: row.relationship,
    relativeName: row.relativeName,
    community: row.community,
    notes: row.notes,
    relativeDeceased: row.relativeDeceased,
    status: row.status as FamilyLinkStatus,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
  };
}

async function openOne(
  organisationId: string,
  row: FamilyLinkRow,
): Promise<FamilyLinkRecord> {
  const [opened] = await openFamilyRows(organisationId, [row]);
  return presentFamilyLink(expectRow(opened, 'family link'));
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
  const row = scope.assertOwned(rows[0]) ?? null;
  if (!row) return null;
  const [opened] = await openFamilyRows(scope.organisationId, [row]);
  return opened ?? null;
}

function assertLinkOnApplication(
  link: FamilyLinkRow | null,
  applicationId: string,
): FamilyLinkRow {
  if (!link || link.applicationId !== applicationId) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  return link;
}

/** Request that a family connection be recorded for an application. */
export async function requestFamilyLink(
  applicationId: string,
  rawInput: RequestFamilyLinkInput,
): Promise<FamilyLinkRecord> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'family-link:request');

  const input = requestFamilyLinkSchema.parse(rawInput);
  // Enforce readability of the application (audits the view).
  await getApplication(applicationId);

  const scope = currentScope();
  const id = uuidv7();
  const relativeDeceased = input.relativeDeceased ?? false;
  const sealed = await sealFamilyFields(scope.organisationId, id, {
    relativeName: input.relativeName,
    community: input.community ?? null,
    notes: input.notes ?? null,
  });
  const stored = await scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(familyLinks)
      .values(
        scope.insertValues({
          id,
          applicationId,
          requestedByUserId: ctx.userId,
          relationship: input.relationship,
          relativeName: sealed.relativeName,
          community: sealed.community,
          notes: sealed.notes,
          relativeDeceased,
          status: 'requested',
        }),
      )
      .returning();
    const created = expectRow(inserted[0], 'family link');

    await recordAudit(
      {
        action: 'family_link.created',
        resourceType: 'family_link',
        resourceId: created.id,
        result: 'success',
        after: {
          data: { applicationId, relationship: input.relationship, relativeDeceased },
          allow: ['applicationId', 'relationship', 'relativeDeceased'],
        },
      },
      tx,
    );
    return created;
  });
  return openOne(scope.organisationId, stored);
}

/** Shared approve/dispute path. `next` is the resulting decided status. */
async function decideLink(
  applicationId: string,
  linkId: string,
  next: 'approved' | 'disputed',
  rawInput: DecideFamilyLinkInput,
): Promise<FamilyLinkRecord> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'family-link:approve');

  const input = decideFamilyLinkSchema.parse(rawInput);
  const link = assertLinkOnApplication(await loadLink(linkId), applicationId);
  if (!canDecide(link.status as FamilyLinkStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This link is already decided.');
  }
  const action = next === 'approved' ? 'family_link.confirmed' : 'family_link.disputed';
  // Separation of duties: the decider must not be the requester. The refusal
  // is a standalone denial event, so it has no business transaction to join.
  try {
    assertDifferentActor(ctx.userId, link.requestedByUserId);
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'SEPARATION_OF_DUTIES') {
      await recordAudit({
        action,
        resourceType: 'family_link',
        resourceId: linkId,
        result: 'denied',
        reason: 'family_link.separation_of_duties',
      });
    }
    throw error;
  }

  const scope = currentScope();
  const decisionNote = await sealFamilyDecisionNote(
    scope.organisationId,
    linkId,
    input.note ?? null,
  );
  const stored = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(familyLinks)
      .set({
        status: next,
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote,
      })
      .where(scope.where(familyLinks.organisationId, eq(familyLinks.id, linkId)))
      .returning();
    const decided = expectRow(updated[0], 'family link');

    await recordAudit(
      {
        action,
        resourceType: 'family_link',
        resourceId: linkId,
        result: 'success',
        reason: input.note ? 'family_link.decision_note' : null,
        before: { data: { status: 'requested' }, allow: ['status'] },
        after: { data: { status: next }, allow: ['status'] },
      },
      tx,
    );
    return decided;
  });
  return openOne(scope.organisationId, stored);
}

/** Approve a requested family link (approver must differ from the requester). */
export async function approveFamilyLink(
  applicationId: string,
  linkId: string,
  rawInput: DecideFamilyLinkInput = {},
): Promise<FamilyLinkRecord> {
  return decideLink(applicationId, linkId, 'approved', rawInput);
}

/** Dispute a requested family link (decider must differ from the requester). */
export async function disputeFamilyLink(
  applicationId: string,
  linkId: string,
  rawInput: DecideFamilyLinkInput = {},
): Promise<FamilyLinkRecord> {
  return decideLink(applicationId, linkId, 'disputed', rawInput);
}

/** Withdraw a link the actor requested, before it is decided. */
export async function withdrawFamilyLink(
  applicationId: string,
  linkId: string,
): Promise<FamilyLinkRecord> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'family-link:request');

  const link = assertLinkOnApplication(await loadLink(linkId), applicationId);
  if (
    link.requestedByUserId !== ctx.userId ||
    !canWithdraw(link.status as FamilyLinkStatus)
  ) {
    throw new AuthorizationError('POLICY_DENIED');
  }

  const scope = currentScope();
  const stored = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(familyLinks)
      .set({ status: 'withdrawn' })
      .where(scope.where(familyLinks.organisationId, eq(familyLinks.id, linkId)))
      .returning();
    const withdrawn = expectRow(updated[0], 'family link');

    await recordAudit(
      {
        action: 'family_link.removed',
        resourceType: 'family_link',
        resourceId: linkId,
        result: 'success',
      },
      tx,
    );
    return withdrawn;
  });
  return openOne(scope.organisationId, stored);
}

/**
 * List family links for an application. Needs a family-link permission and a
 * staff read of the case; the application read policy also applies.
 */
export async function listFamilyLinks(
  applicationId: string,
): Promise<FamilyLinkRecord[]> {
  const ctx = requireTenantContext();
  if (!canReadFamilyLinks(subjectFromContext(ctx))) {
    throw new AuthorizationError('PERMISSION_DENIED');
  }
  // Enforces the application read policy and audits the view.
  await getApplication(applicationId);

  const scope = currentScope();
  const rows = await scope.db
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
  const opened = await openFamilyRows(scope.organisationId, rows);
  return opened.map(presentFamilyLink);
}
