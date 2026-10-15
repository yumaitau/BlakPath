import {
  and,
  desc,
  eq,
  exists,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Database } from '@/db/client';
import {
  beforeConditionalWrite,
  nextRowVersion,
  takeVersionText,
  versionedSelection,
  versionMatches,
} from '@/lib/concurrency/claim';
import { ConcurrencyConflictError } from '@/lib/concurrency/error';
import {
  applications,
  applicationAssignments,
  applicationNotes,
  applicationStatusHistory,
  clients,
  membershipRoles,
  organisations,
  memberships,
  roles,
  teamMemberships,
  users,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { auditReason } from '@/domains/audit/hash';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext, type TenantContext } from '@/lib/tenancy/context';
import {
  requireAny,
  requirePermission,
  subjectFromContext,
  type Subject,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { notifyWorkflowEvent } from '@/domains/notifications/dispatch';
import { isPubliclyAcceptingApplications } from '@/domains/organisations/public-applications';
import { applicantMayActOnCase } from '@/lib/auth/landing';
import { isApplicantOnlyRoleSet } from '@/lib/permissions/roles';
import { applicationIntakeAuditMeta } from './audit-meta';
import { applicationSearchMac } from '@/lib/encryption/blind-index';
import {
  openApplicationRows,
  openNoteRows,
  sealApplicationFields,
  sealNoteBody,
} from '@/lib/encryption/tenant-fields';
import { decodeApplicationCursor, encodeApplicationCursor } from './cursor';
import { canReadApplication, readsAllApplications } from './policies';
import {
  addNoteSchema,
  assignApplicationSchema,
  createApplicationSchema,
  listApplicationsSchema,
  transitionApplicationSchema,
  updateIntakeSchema,
  type AddNoteInput,
  type AssignApplicationInput,
  type CreateApplicationInput,
  type ListApplicationsInput,
  type TransitionApplicationInput,
  type UpdateIntakeInput,
} from './schemas';
import {
  nextStatus,
  permissionsForAction,
  TRANSITIONS,
  type ApplicationAction,
  type ApplicationStatus,
} from './workflow';

/**
 * Applications service — the tenant-scoped, permission-checked, audited write
 * and read path for application matters.
 *
 * Every function here follows the same shape:
 *   1. read the DB-verified TenantContext (never trust ids from input);
 *   2. gate on the relevant permission / read policy;
 *   3. act through a tenant scope so `organisation_id` is always applied;
 *   4. record an audit event on the tamper-evident trail.
 *
 * The workflow state machine (workflow.ts) is the single source of truth for
 * legal status transitions; this layer enforces WHO may act and records that
 * they did — it never makes a determination of Aboriginality.
 */

export type ApplicationRow = typeof applications.$inferSelect;
export type ApplicationAssignmentRow = typeof applicationAssignments.$inferSelect;
export type ApplicationNoteRow = typeof applicationNotes.$inferSelect;
export type ApplicationStatusHistoryRow = typeof applicationStatusHistory.$inferSelect;

/** Columns that may be patched on an application update. */
type ApplicationPatch = Partial<typeof applications.$inferInsert>;

/** The transaction handle drizzle passes to a `db.transaction(...)` callback. */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type DbExecutor = Database | DbTransaction;

/** A workflow write applied on a caller-supplied executor, before its audit. */
export interface AppliedApplicationTransition {
  readonly row: ApplicationRow;
  readonly from: ApplicationStatus;
  readonly to: ApplicationStatus;
  readonly note: string | null;
  /** The status-history row holding `note`; the audit reason points at it. */
  readonly statusHistoryId: string | null;
}

/** An application together with its active assignee ids (for read policy). */
export interface ApplicationDetail {
  readonly application: ApplicationRow;
  readonly assigneeUserIds: readonly string[];
}

/** Read model for the staff case workspace. */
export interface ApplicationCaseRecord extends ApplicationDetail {
  readonly assignments: readonly ApplicationAssignmentRow[];
  readonly statusHistory: readonly ApplicationStatusHistoryRow[];
  readonly notes: readonly ApplicationNoteRow[];
}

export interface ApplicationParticipant {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

/** A staff member the register may offer in the assignee filter. */
export interface RegisterAssignee {
  readonly userId: string;
  readonly name: string;
}

export interface ApplicationListResult {
  readonly items: ApplicationRow[];
  readonly limit: number;
  readonly offset: number;
  readonly nextCursor: string | null;
}

/** Roles that do not hold a case. Kept out of the assignee filter. */
const NON_ASSIGNEE_ROLE_SLUGS = ['applicant', 'applicant-representative'] as const;

/** Build a human-friendly per-organisation reference from a fresh id. */
function makeReference(id: string): string {
  // Year is presentational only; uniqueness is guaranteed by the id tail and
  // the (organisation_id, reference_bidx) unique index.
  const year = new Date().getUTCFullYear();
  const tail = id.replace(/-/g, '').slice(-6).toUpperCase();
  return `APP-${year}-${tail}`;
}

/** Predicate: application row, within tenant scope and not soft-deleted. */
function liveApplication(where: SQL): SQL {
  return and(where, isNull(applications.deletedAt)) as SQL;
}

/**
 * Load a single application within scope plus the exact `version` text a
 * conditional update must match, or return null. One statement so status and
 * version cannot diverge between queries.
 */
async function loadApplicationClaimOn(
  executor: DbExecutor,
  id: string,
): Promise<{ row: ApplicationRow; versionText: string } | null> {
  const scope = currentScope();
  const rows = await executor
    .select(versionedSelection(applications))
    .from(applications)
    .where(
      liveApplication(scope.where(applications.organisationId, eq(applications.id, id))),
    )
    .limit(1);
  const owned = scope.assertOwned(rows[0]);
  if (!owned) return null;
  const split = takeVersionText(owned);
  if (!split) return null;
  const [opened] = await openApplicationRows(scope.organisationId, [
    split.record as ApplicationRow,
  ]);
  return opened ? { row: opened, versionText: split.versionText } : null;
}

/** Load a single application within scope, or return null. */
async function loadApplication(id: string): Promise<ApplicationRow | null> {
  const loaded = await loadApplicationClaimOn(currentScope().db, id);
  return loaded?.row ?? null;
}

/** Load the user ids with an ACTIVE assignment on an application. */
async function activeAssigneeIds(applicationId: string): Promise<string[]> {
  const scope = currentScope();
  const rows = await scope.db
    .select({ assigneeUserId: applicationAssignments.assigneeUserId })
    .from(applicationAssignments)
    .where(
      scope.where(
        applicationAssignments.organisationId,
        eq(applicationAssignments.applicationId, applicationId),
        eq(applicationAssignments.status, 'active'),
      ),
    );
  return rows.map((r) => r.assigneeUserId);
}

/** Client must already belong to the active tenant. Returns the owned id. */
async function resolveClientId(clientId: string): Promise<string> {
  const scope = currentScope();
  const [client] = await scope.db
    .select({ id: clients.id })
    .from(clients)
    .where(
      scope.where(
        clients.organisationId,
        eq(clients.id, clientId),
        isNull(clients.deletedAt),
      ),
    )
    .limit(1);
  if (!client) throw new AuthorizationError('POLICY_DENIED');
  return client.id;
}

/** Assignee must be an active member of the active tenant. */
async function assertActiveAssignee(userId: string): Promise<void> {
  const scope = currentScope();
  const [member] = await scope.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      scope.where(
        memberships.organisationId,
        eq(memberships.userId, userId),
        eq(memberships.status, 'active'),
      ),
    )
    .limit(1);
  if (!member) throw new AuthorizationError('POLICY_DENIED');
}

/** Load user ids in the team owning the application's client, if any. */
async function clientTeamMemberIds(application: ApplicationRow): Promise<string[]> {
  if (!application.clientId) return [];
  const scope = currentScope();
  const rows = await scope.db
    .select({ userId: teamMemberships.userId })
    .from(clients)
    .innerJoin(
      teamMemberships,
      and(
        eq(teamMemberships.teamId, clients.assignedTeamId),
        eq(teamMemberships.organisationId, clients.organisationId),
      ),
    )
    .where(
      scope.where(
        clients.organisationId,
        eq(clients.id, application.clientId),
        isNull(clients.deletedAt),
      ),
    );
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * Fetch an application the actor is permitted to read. Throws a non-leaking
 * {@link AuthorizationError} when it does not exist OR the actor may not read
 * it — the two cases are deliberately indistinguishable to the caller.
 */
export async function getApplication(id: string): Promise<ApplicationDetail> {
  const ctx = requireTenantContext();
  const subject = subjectFromContext(ctx);

  const application = await loadApplication(id);
  const assigneeUserIds = application ? await activeAssigneeIds(id) : [];
  const teamMemberUserIds = application ? await clientTeamMemberIds(application) : [];

  const readable =
    application !== null &&
    canReadApplication(subject, {
      applicantUserId: application.applicantUserId,
      assigneeUserIds,
      teamMemberUserIds,
    });

  if (!application || !readable) {
    await recordAudit({
      action: 'application.viewed',
      resourceType: 'application',
      resourceId: id,
      result: 'denied',
      reason: 'application.not_readable',
    });
    // Same error whether missing or forbidden — never reveal which.
    throw new AuthorizationError('POLICY_DENIED');
  }

  await recordAudit({
    action: 'application.viewed',
    resourceType: 'application',
    resourceId: id,
    result: 'success',
  });

  return { application, assigneeUserIds };
}

/** Load the auditable case history after applying the normal application read policy. */
export async function getApplicationCaseRecord(
  id: string,
): Promise<ApplicationCaseRecord> {
  const detail = await getApplication(id);
  const scope = currentScope();
  const [assignments, statusHistory, notes] = await Promise.all([
    scope.db
      .select()
      .from(applicationAssignments)
      .where(
        scope.where(
          applicationAssignments.organisationId,
          eq(applicationAssignments.applicationId, id),
        ),
      )
      .orderBy(desc(applicationAssignments.assignedAt)),
    scope.db
      .select()
      .from(applicationStatusHistory)
      .where(
        scope.where(
          applicationStatusHistory.organisationId,
          eq(applicationStatusHistory.applicationId, id),
        ),
      )
      .orderBy(desc(applicationStatusHistory.createdAt)),
    scope.db
      .select()
      .from(applicationNotes)
      .where(
        scope.where(
          applicationNotes.organisationId,
          eq(applicationNotes.applicationId, id),
          isNull(applicationNotes.deletedAt),
        ),
      )
      .orderBy(desc(applicationNotes.createdAt)),
  ]);

  return {
    ...detail,
    assignments,
    statusHistory,
    notes: await openNoteRows(scope.organisationId, notes),
  };
}

/** List active applicant-role accounts that intake staff may link to a new case. */
export async function listApplicationParticipants(): Promise<ApplicationParticipant[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'application:create');
  const scope = currentScope();
  return scope.db
    .selectDistinct({ userId: users.id, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(
      scope.where(
        memberships.organisationId,
        eq(memberships.status, 'active'),
        eq(roles.slug, 'applicant'),
      ),
    )
    .orderBy(users.name);
}

/** Active staff the register can filter by. Requires `application:read-any`. */
export async function listRegisterAssignees(): Promise<RegisterAssignee[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'application:read-any');
  const scope = currentScope();
  return scope.db
    .selectDistinct({ userId: users.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(
      scope.where(
        memberships.organisationId,
        eq(memberships.status, 'active'),
        notInArray(roles.slug, [...NON_ASSIGNEE_ROLE_SLUGS]),
      ),
    )
    .orderBy(users.name);
}

/** Create a new application in `draft`. Requires `application:create`. */
export async function createApplication(
  rawInput: CreateApplicationInput,
): Promise<ApplicationRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'application:create');

  const input = createApplicationSchema.parse(rawInput);
  const scope = currentScope();

  const applicantOnly = isApplicantOnlyRoleSet(ctx.roles);

  // Applicant accounts can start a matter only when the organisation has
  // opened public applications. Staff intake is unchanged when the flag is off.
  if (applicantOnly) {
    const [org] = await scope.db
      .select({
        status: organisations.status,
        publicApplicationsOpen: organisations.publicApplicationsOpen,
      })
      .from(organisations)
      .where(eq(organisations.id, scope.organisationId))
      .limit(1);
    if (!org || !isPubliclyAcceptingApplications(org)) {
      await recordAudit({
        action: 'application.created',
        resourceType: 'application',
        result: 'denied',
        reason: 'application.public_intake_closed',
      });
      throw new AuthorizationError('POLICY_DENIED');
    }
  }

  // Optional client link must belong to this tenant, else the matter could
  // silently attach to another tenant's person record. Applicants cannot
  // attach a client or name a different person as the applicant.
  const clientId =
    !applicantOnly && input.clientId ? await resolveClientId(input.clientId) : null;

  const id = uuidv7();
  const reference = makeReference(id);
  const sealed = await sealApplicationFields(scope.organisationId, id, {
    applicantName: input.applicantName,
    intake: input.intake ?? null,
    reference,
  });
  const applicantName = sealed.applicantName;
  const referenceBidx = sealed.referenceBidx;
  const applicantNameBidx = sealed.applicantNameBidx;
  const applicantNameTokenBidx = sealed.applicantNameTokenBidx;
  if (!applicantName || !referenceBidx || !applicantNameBidx || !applicantNameTokenBidx) {
    throw new Error('Applicant fields were not sealed');
  }

  const stored = await scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(applications)
      .values(
        scope.insertValues({
          id,
          reference,
          applicantName,
          applicantUserId: applicantOnly ? ctx.userId : (input.applicantUserId ?? null),
          clientId,
          priority: applicantOnly ? 'normal' : input.priority,
          intake: sealed.intake ?? null,
          referenceBidx,
          applicantNameBidx,
          applicantNameTokenBidx,
          createdByUserId: ctx.userId,
          status: 'draft',
        }),
      )
      .returning();
    const created = expectRow(inserted[0], 'application');

    await tx.insert(applicationStatusHistory).values(
      scope.insertValues({
        applicationId: id,
        fromStatus: null,
        toStatus: 'draft',
        action: 'create',
        actorUserId: ctx.userId,
      }),
    );

    await recordAudit(
      {
        action: 'application.created',
        resourceType: 'application',
        resourceId: id,
        result: 'success',
        after: {
          data: { reference, status: 'draft', priority: created.priority, clientId },
          allow: ['reference', 'status', 'priority', 'clientId'],
        },
      },
      tx,
    );
    return created;
  });
  const [row] = await openApplicationRows(scope.organisationId, [stored]);
  return expectRow(row, 'application');
}

/** Update intake details. Requires `application:update-intake`. */
export async function updateIntake(
  id: string,
  rawInput: UpdateIntakeInput,
): Promise<ApplicationRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'application:update-intake');

  const input = updateIntakeSchema.parse(rawInput);
  const existing = await loadApplication(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const sealed = await sealApplicationFields(scope.organisationId, id, {
    ...(input.applicantName !== undefined ? { applicantName: input.applicantName } : {}),
    ...(input.intake !== undefined ? { intake: input.intake } : {}),
  });
  const patch: ApplicationPatch = {};
  if (input.applicantName !== undefined) {
    const applicantName = sealed.applicantName;
    const applicantNameBidx = sealed.applicantNameBidx;
    const applicantNameTokenBidx = sealed.applicantNameTokenBidx;
    if (!applicantName || !applicantNameBidx || !applicantNameTokenBidx) {
      throw new Error('Applicant name was not sealed');
    }
    patch.applicantName = applicantName;
    patch.applicantNameBidx = applicantNameBidx;
    patch.applicantNameTokenBidx = applicantNameTokenBidx;
  }
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.intake !== undefined) patch.intake = sealed.intake ?? null;
  if (input.clientId !== undefined) {
    patch.clientId = await resolveClientId(input.clientId);
  }

  const changed: string[] = [];
  if (
    input.applicantName !== undefined &&
    input.applicantName !== existing.applicantName
  ) {
    changed.push('applicantName');
  }
  if (input.priority !== undefined && input.priority !== existing.priority) {
    changed.push('priority');
  }
  if (input.intake !== undefined) changed.push('intake');
  if (input.clientId !== undefined && patch.clientId !== existing.clientId) {
    changed.push('clientId');
  }

  const stored = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(applications)
      .set(patch)
      .where(scope.where(applications.organisationId, eq(applications.id, id)))
      .returning();
    const saved = expectRow(updated[0], 'application');

    const intakeAudit = applicationIntakeAuditMeta({
      beforePriority: existing.priority,
      afterPriority: saved.priority,
      changed,
    });

    await recordAudit(
      {
        action: 'application.updated',
        resourceType: 'application',
        resourceId: id,
        result: 'success',
        before: intakeAudit.before,
        after: intakeAudit.after,
      },
      tx,
    );
    return saved;
  });
  const [row] = await openApplicationRows(scope.organisationId, [stored]);
  return expectRow(row, 'application');
}

/** Assign (or reassign) an application to a worker. Requires `application:assign`. */
export async function assignApplication(
  id: string,
  rawInput: AssignApplicationInput,
): Promise<ApplicationAssignmentRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'application:assign');

  const input = assignApplicationSchema.parse(rawInput);
  const existing = await loadApplication(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');
  await assertActiveAssignee(input.assigneeUserId);

  const scope = currentScope();
  const priorAssignees = await activeAssigneeIds(id);
  const isReassignment = priorAssignees.length > 0;

  const assignment = await scope.db.transaction(async (tx) => {
    // Release any current active assignments — history is preserved, not edited.
    await tx
      .update(applicationAssignments)
      .set({ status: 'released', releasedAt: new Date() })
      .where(
        and(
          eq(applicationAssignments.organisationId, scope.organisationId),
          eq(applicationAssignments.applicationId, id),
          eq(applicationAssignments.status, 'active'),
        ),
      );

    const insertedAssignment = await tx
      .insert(applicationAssignments)
      .values(
        scope.insertValues({
          applicationId: id,
          assigneeUserId: input.assigneeUserId,
          assignedByUserId: ctx.userId,
          roleContext: input.roleContext ?? null,
          status: 'active',
        }),
      )
      .returning();
    const assignment = expectRow(insertedAssignment[0], 'assignment');

    await tx
      .update(applications)
      .set({ currentAssigneeUserId: input.assigneeUserId })
      .where(
        and(
          eq(applications.organisationId, scope.organisationId),
          eq(applications.id, id),
        ),
      );

    await recordAudit(
      {
        action: isReassignment ? 'assignment.reassigned' : 'assignment.assigned',
        resourceType: 'assignment',
        resourceId: assignment.id,
        result: 'success',
        after: {
          data: { applicationId: id, assigneeUserId: input.assigneeUserId },
          allow: ['applicationId', 'assigneeUserId'],
        },
      },
      tx,
    );

    return assignment;
  });

  await notifyWorkflowEvent({
    organisationId: ctx.organisationId,
    correlationId: ctx.correlationId,
    event: {
      kind: 'assignment',
      applicationId: id,
      assigneeUserId: input.assigneeUserId,
      actorUserId: ctx.userId,
    },
  });

  return assignment;
}

/** An applicant-only actor tried to move a matter they are not named on. */
class ApplicantNotOwnerError extends AuthorizationError {
  constructor() {
    super('POLICY_DENIED');
  }
}

/**
 * Write a workflow transition on `executor` without auditing.
 *
 * Callers that already hold a transaction (finalising a decision) pass that
 * transaction so the case move commits or rolls back with their own write.
 * Throws {@link ApplicationWorkflowError} when the move is illegal from the
 * status read inside this call.
 */
export async function applyApplicationTransition(
  executor: DbExecutor,
  id: string,
  action: ApplicationAction,
  rawInput: TransitionApplicationInput = {},
): Promise<AppliedApplicationTransition> {
  const ctx = requireTenantContext();
  const subject: Subject = subjectFromContext(ctx);
  requireAny(subject, permissionsForAction(action));

  const input = transitionApplicationSchema.parse(rawInput);
  const loaded = await loadApplicationClaimOn(executor, id);
  if (!loaded) throw new AuthorizationError('POLICY_DENIED');
  const existing = loaded.row;

  // Applicant-only actors cannot move someone else's matter, even if a
  // permission key such as application:create would otherwise match. The
  // caller audits the refusal after the transaction rolls back.
  if (!applicantMayActOnCase(ctx.roles, ctx.userId, existing.applicantUserId)) {
    throw new ApplicantNotOwnerError();
  }

  const from = existing.status as ApplicationStatus;
  const to = nextStatus(action, from);

  const scope = currentScope();
  const now = new Date();
  const patch: ApplicationPatch = { status: to };
  if (action === 'submit') patch.submittedAt = now;
  if (action === 'record_decision') patch.decidedAt = now;
  if (action === 'withdraw') {
    patch.withdrawnAt = now;
    patch.withdrawnReason = input.note ?? null;
  }
  if (action === 'close') patch.closedAt = now;

  const note = input.note ?? null;
  // Both racers pass the in-memory check. Only the update whose status and
  // version still match the read may write; the loser throws and rolls back
  // the caller's transaction, so status history cannot gain a second row for
  // the same move.
  await beforeConditionalWrite();
  const updated = await executor
    .update(applications)
    .set({ ...patch, version: nextRowVersion() })
    .where(
      scope.where(
        applications.organisationId,
        eq(applications.id, id),
        eq(applications.status, from),
        versionMatches(applications.version, loaded.versionText),
      ),
    )
    .returning();
  if (updated.length === 0) {
    throw new ConcurrencyConflictError(
      'This application changed while you were working. Refresh and try again.',
    );
  }

  const history = await executor
    .insert(applicationStatusHistory)
    .values(
      scope.insertValues({
        applicationId: id,
        fromStatus: from,
        toStatus: to,
        action,
        actorUserId: ctx.userId,
        note,
      }),
    )
    .returning({ id: applicationStatusHistory.id });
  const statusHistoryId = history[0]?.id ?? null;

  return { row: expectRow(updated[0], 'application'), from, to, note, statusHistoryId };
}

/** Audit a transition inside the transaction that wrote it. */
export async function recordApplicationTransitionAudit(
  action: ApplicationAction,
  applied: AppliedApplicationTransition,
  tx: DbTransaction,
): Promise<void> {
  // The note text stays on application_status_history (mutable). The trail
  // records the code and, when a note was written, that row's id.
  const reason =
    applied.note && applied.statusHistoryId
      ? auditReason('application.transition_note', applied.statusHistoryId)
      : null;

  await recordAudit(
    {
      action: TRANSITIONS[action].audit,
      resourceType: 'application',
      resourceId: applied.row.id,
      result: 'success',
      reason,
      before: { data: { status: applied.from }, allow: ['status'] },
      after: {
        data: {
          status: applied.to,
          action,
          ...(applied.statusHistoryId
            ? { statusHistoryId: applied.statusHistoryId }
            : {}),
        },
        allow: ['status', 'action', 'statusHistoryId'],
      },
    },
    tx,
  );
}

/**
 * Apply a workflow transition. The action is authorised by ANY of the
 * permissions the workflow declares for it, and the move must be legal from the
 * application's current status (else the workflow throws).
 */
export async function transitionApplication(
  id: string,
  action: ApplicationAction,
  rawInput: TransitionApplicationInput = {},
): Promise<ApplicationRow> {
  let applied: AppliedApplicationTransition;
  try {
    applied = await currentScope().db.transaction(async (tx) => {
      const result = await applyApplicationTransition(tx, id, action, rawInput);
      await recordApplicationTransitionAudit(action, result, tx);
      return result;
    });
  } catch (error) {
    if (!(error instanceof ApplicantNotOwnerError)) throw error;
    await recordAudit({
      action: TRANSITIONS[action].audit,
      resourceType: 'application',
      resourceId: id,
      result: 'denied',
      reason: 'application.applicant_not_owner',
    });
    throw error;
  }
  if (applied.to === 'in_review') {
    const ctx = requireTenantContext();
    await notifyWorkflowEvent({
      organisationId: ctx.organisationId,
      correlationId: ctx.correlationId,
      event: {
        kind: 'review_needed',
        applicationId: id,
        actorUserId: ctx.userId,
      },
    });
  }
  const [opened] = await openApplicationRows(applied.row.organisationId, [applied.row]);
  return expectRow(opened, 'application');
}

/**
 * List applications within the tenant. Actors with `application:read-any` see
 * every application; everyone else sees only applications they are the
 * applicant on or actively assigned to.
 *
 * Text search is an equality lookup on the tenant blind index (reference, full
 * name, or one whole name word), then a keyset page on `(created_at, id)`
 * descending. Results stay in record order. Search does not rank or score a
 * person.
 */
export async function listApplications(
  rawInput: ListApplicationsInput = {},
): Promise<ApplicationListResult> {
  const ctx = requireTenantContext();
  const subject = subjectFromContext(ctx);
  const input = listApplicationsSchema.parse(rawInput);
  const scope = currentScope();
  const position = input.cursor ? decodeApplicationCursor(input.cursor) : null;
  if (input.cursor && !position) {
    throw new Error('Invalid page cursor.');
  }

  const filters: Array<SQL | undefined> = [isNull(applications.deletedAt)];
  if (input.status) filters.push(eq(applications.status, input.status));
  if (input.assigneeUserId) {
    filters.push(eq(applications.currentAssigneeUserId, input.assigneeUserId));
  }
  if (input.applicantUserId) {
    filters.push(eq(applications.applicantUserId, input.applicantUserId));
  }
  if (position) {
    // Row comparison at Postgres precision: created_at is microseconds, so
    // the cursor carries the exact text value rather than a JS Date.
    filters.push(
      sql`(${applications.createdAt}, ${applications.id}) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`,
    );
  }
  if (input.q) {
    const mac = await applicationSearchMac(scope.organisationId, input.q);
    if (mac) {
      filters.push(
        or(
          eq(applications.referenceBidx, mac),
          eq(applications.applicantNameBidx, mac),
          sql`${mac} = ANY(${applications.applicantNameTokenBidx})`,
        ),
      );
    }
  }

  // Applicant-only accounts see their own matters and nothing else. Staff
  // without read-any still see own, assigned, and team matters.
  if (isApplicantOnlyRoleSet(ctx.roles)) {
    filters.push(eq(applications.applicantUserId, subject.userId));
  } else if (!readsAllApplications(subject)) {
    filters.push(
      or(
        eq(applications.applicantUserId, subject.userId),
        eq(applications.currentAssigneeUserId, subject.userId),
        exists(
          scope.db
            .select({ one: clients.id })
            .from(clients)
            .innerJoin(
              teamMemberships,
              and(
                eq(teamMemberships.teamId, clients.assignedTeamId),
                eq(teamMemberships.organisationId, clients.organisationId),
              ),
            )
            .where(
              and(
                eq(clients.organisationId, applications.organisationId),
                eq(clients.id, applications.clientId),
                isNull(clients.deletedAt),
                eq(teamMemberships.userId, subject.userId),
              ),
            ),
        ),
      ),
    );
  }

  const offset = position ? 0 : input.offset;
  const rows = await scope.db
    .select({
      row: applications,
      cursorAt: sql<string>`to_char(${applications.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(applications)
    .where(scope.where(applications.organisationId, ...filters))
    .orderBy(desc(applications.createdAt), desc(applications.id))
    .limit(input.limit + 1)
    .offset(offset);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeApplicationCursor({ createdAt: last.cursorAt, id: last.row.id })
      : null;

  return {
    items: await openApplicationRows(
      scope.organisationId,
      page.map((entry) => entry.row),
    ),
    limit: input.limit,
    offset,
    nextCursor,
  };
}

/**
 * Add a note to an application. Requires a read capability on applications —
 * staff who can see the matter may annotate it.
 */
export async function addNote(
  id: string,
  rawInput: AddNoteInput,
): Promise<ApplicationNoteRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), [
    'application:read-any',
    'application:read-assigned',
    'application:update-intake',
  ]);

  const input = addNoteSchema.parse(rawInput);
  const existing = await loadApplication(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const noteId = uuidv7();
  const body = await sealNoteBody(scope.organisationId, noteId, input.body);
  const stored = await scope.db.transaction(async (tx) => {
    const insertedNote = await tx
      .insert(applicationNotes)
      .values(
        scope.insertValues({
          id: noteId,
          applicationId: id,
          authorUserId: ctx.userId,
          body,
          visibility: input.visibility,
        }),
      )
      .returning();
    const created = expectRow(insertedNote[0], 'note');

    await recordAudit(
      {
        action: 'record.created',
        resourceType: 'record',
        resourceId: created.id,
        result: 'success',
        after: {
          data: { applicationId: id, visibility: input.visibility },
          allow: ['applicationId', 'visibility'],
        },
      },
      tx,
    );
    return created;
  });
  const [note] = await openNoteRows(scope.organisationId, [stored]);
  return expectRow(note, 'note');
}

/** Re-export the context type for callers that thread it explicitly. */
export type { TenantContext };
