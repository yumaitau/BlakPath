import { desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
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
  openFamilyField,
  sealFamilyField,
  type FamilyLinkFieldContext,
  type FamilyLinkSealedColumn,
} from './fields';
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
 * `relative_name`, `community`, `notes`, and `decision_note` are sealed before
 * insert. Callers receive plaintext only after a successful open.
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
  /** True when a sealed column could not be opened. Plaintext is withheld. */
  sensitiveFieldsUnreadable: boolean;
}

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${what} to be returned from the database.`);
  }
  return row;
}

function fieldContext(
  row: { organisationId: string; id: string },
  column: FamilyLinkSealedColumn,
): FamilyLinkFieldContext {
  return { organisationId: row.organisationId, rowId: row.id, column };
}

function sealOptional(
  value: string | undefined,
  ctx: FamilyLinkFieldContext,
): string | null {
  if (!value) return null;
  return sealFamilyField(value, ctx);
}

function readSealed(
  stored: string | null,
  ctx: FamilyLinkFieldContext,
): { value: string | null; unreadable: boolean } {
  if (stored === null) return { value: null, unreadable: false };
  try {
    return { value: openFamilyField(stored, ctx), unreadable: false };
  } catch {
    return { value: null, unreadable: true };
  }
}

/** Open sealed columns. A failure withholds that text instead of returning ciphertext. */
function presentFamilyLink(row: FamilyLinkRow): FamilyLinkRecord {
  const name = readSealed(row.relativeName, fieldContext(row, 'relative_name'));
  const community = readSealed(row.community, fieldContext(row, 'community'));
  const notes = readSealed(row.notes, fieldContext(row, 'notes'));
  const decisionNote = readSealed(row.decisionNote, fieldContext(row, 'decision_note'));
  return {
    id: row.id,
    applicationId: row.applicationId,
    requestedByUserId: row.requestedByUserId,
    relationship: row.relationship,
    relativeName: name.value ?? '',
    community: community.value,
    notes: notes.value,
    relativeDeceased: row.relativeDeceased,
    status: row.status as FamilyLinkStatus,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    decisionNote: decisionNote.value,
    createdAt: row.createdAt,
    sensitiveFieldsUnreadable:
      name.unreadable ||
      community.unreadable ||
      notes.unreadable ||
      decisionNote.unreadable,
  };
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

  const id = uuidv7();
  const scope = currentScope();
  const inserted = await scope.db
    .insert(familyLinks)
    .values(
      scope.insertValues({
        id,
        applicationId,
        requestedByUserId: ctx.userId,
        relationship: input.relationship,
        relativeName: sealFamilyField(input.relativeName, {
          organisationId: ctx.organisationId,
          rowId: id,
          column: 'relative_name',
        }),
        community: sealOptional(input.community, {
          organisationId: ctx.organisationId,
          rowId: id,
          column: 'community',
        }),
        notes: sealOptional(input.notes, {
          organisationId: ctx.organisationId,
          rowId: id,
          column: 'notes',
        }),
        relativeDeceased: input.relativeDeceased ?? false,
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
      data: {
        applicationId,
        relationship: input.relationship,
        relativeDeceased: input.relativeDeceased ?? false,
      },
      allow: ['applicationId', 'relationship', 'relativeDeceased'],
    },
  });

  return presentFamilyLink(row);
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
  // Separation of duties: the decider must not be the requester.
  try {
    assertDifferentActor(ctx.userId, link.requestedByUserId);
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'SEPARATION_OF_DUTIES') {
      await recordAudit({
        action: next === 'approved' ? 'family_link.confirmed' : 'family_link.disputed',
        resourceType: 'family_link',
        resourceId: linkId,
        result: 'denied',
        reason: 'separation of duties',
      });
    }
    throw error;
  }

  const scope = currentScope();
  const updated = await scope.db
    .update(familyLinks)
    .set({
      status: next,
      decidedByUserId: ctx.userId,
      decidedAt: new Date(),
      decisionNote: sealOptional(input.note, fieldContext(link, 'decision_note')),
    })
    .where(scope.where(familyLinks.organisationId, eq(familyLinks.id, linkId)))
    .returning();
  const row = must(updated[0], 'family link');

  await recordAudit({
    action: next === 'approved' ? 'family_link.confirmed' : 'family_link.disputed',
    resourceType: 'family_link',
    resourceId: linkId,
    result: 'success',
    before: { data: { status: 'requested' }, allow: ['status'] },
    after: { data: { status: next }, allow: ['status'] },
  });

  return presentFamilyLink(row);
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

  return presentFamilyLink(row);
}

/** List family links for an application the actor may read. */
export async function listFamilyLinks(
  applicationId: string,
): Promise<FamilyLinkRecord[]> {
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
  return rows.map((row) => presentFamilyLink(row));
}
