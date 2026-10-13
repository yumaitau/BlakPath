import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  notExists,
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  applications,
  applicationAssignments,
  applicationNotes,
  applicationSearchTokens,
  applicationStatusHistory,
  clients,
  membershipRoles,
  memberships,
  roles,
  teamMemberships,
  users,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext, type TenantContext } from '@/lib/tenancy/context';
import {
  requireAny,
  requirePermission,
  subjectFromContext,
  type Subject,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { queryTokens } from '@/lib/search/blind-index';
import { decodeApplicationCursor, encodeApplicationCursor } from './cursor';
import { canReadApplication, readsAllApplications } from './policies';
import { blindTokensForPrefix, writeApplicationSearchTokens } from './search-index';
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

const SEARCH_BACKFILL_BATCH = 100;
const SEARCH_BACKFILL_ROUNDS = 20;

/** Roles that do not hold a case. Kept out of the assignee filter. */
const NON_ASSIGNEE_ROLE_SLUGS = ['applicant', 'applicant-representative'] as const;

/**
 * Rows created before the search index existed have no tokens. A search fills
 * them in bounded batches so the first lookup after deploy can still see them.
 * Later searches find the index already populated.
 */
async function ensureSearchTokens(scope: ReturnType<typeof currentScope>): Promise<void> {
  for (let round = 0; round < SEARCH_BACKFILL_ROUNDS; round += 1) {
    const missing = await scope.db
      .select({
        id: applications.id,
        reference: applications.reference,
        applicantName: applications.applicantName,
      })
      .from(applications)
      .where(
        scope.where(
          applications.organisationId,
          isNull(applications.deletedAt),
          notExists(
            scope.db
              .select({ applicationId: applicationSearchTokens.applicationId })
              .from(applicationSearchTokens)
              .where(
                and(
                  eq(applicationSearchTokens.organisationId, applications.organisationId),
                  eq(applicationSearchTokens.applicationId, applications.id),
                ),
              ),
          ),
        ),
      )
      .limit(SEARCH_BACKFILL_BATCH);
    if (missing.length === 0) return;
    for (const row of missing) {
      await writeApplicationSearchTokens(scope.db, scope.organisationId, row);
    }
    if (missing.length < SEARCH_BACKFILL_BATCH) return;
  }
}

/** Assert a row was returned from an insert/update `.returning()`. */
function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${what} to be returned from the database.`);
  }
  return row;
}

/** Build a human-friendly per-organisation reference from a fresh id. */
function makeReference(id: string): string {
  // Year is presentational only; uniqueness is guaranteed by the id tail and
  // the (organisation_id, reference) unique index.
  const year = new Date().getUTCFullYear();
  const tail = id.replace(/-/g, '').slice(-6).toUpperCase();
  return `APP-${year}-${tail}`;
}

/** Predicate: application row, within tenant scope and not soft-deleted. */
function liveApplication(where: SQL): SQL {
  return and(where, isNull(applications.deletedAt)) as SQL;
}

/** Load a single application within scope, or return null. */
async function loadApplication(id: string): Promise<ApplicationRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(applications)
    .where(
      liveApplication(scope.where(applications.organisationId, eq(applications.id, id))),
    )
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
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
      reason: 'not readable by actor or not found',
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

  return { ...detail, assignments, statusHistory, notes };
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

  // Optional client link must belong to this tenant, else the matter could
  // silently attach to another tenant's person record.
  let clientId: string | null = null;
  if (input.clientId) {
    const [client] = await scope.db
      .select({ id: clients.id })
      .from(clients)
      .where(
        scope.where(
          clients.organisationId,
          eq(clients.id, input.clientId),
          isNull(clients.deletedAt),
        ),
      )
      .limit(1);
    if (!client) throw new AuthorizationError('POLICY_DENIED');
    clientId = client.id;
  }

  const id = uuidv7();
  const reference = makeReference(id);

  const inserted = await scope.db
    .insert(applications)
    .values(
      scope.insertValues({
        id,
        reference,
        applicantName: input.applicantName,
        applicantUserId: input.applicantUserId ?? null,
        clientId,
        priority: input.priority,
        intake: input.intake ?? null,
        createdByUserId: ctx.userId,
        status: 'draft',
      }),
    )
    .returning();
  const row = must(inserted[0], 'application');

  await scope.db.insert(applicationStatusHistory).values(
    scope.insertValues({
      applicationId: id,
      fromStatus: null,
      toStatus: 'draft',
      action: 'create',
      actorUserId: ctx.userId,
    }),
  );

  await writeApplicationSearchTokens(scope.db, scope.organisationId, {
    id: row.id,
    reference: row.reference,
    applicantName: row.applicantName,
  });

  await recordAudit({
    action: 'application.created',
    resourceType: 'application',
    resourceId: id,
    result: 'success',
    after: {
      data: { reference, status: 'draft', priority: input.priority },
      allow: ['reference', 'status', 'priority'],
    },
  });

  return row;
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
  const patch: ApplicationPatch = {};
  if (input.applicantName !== undefined) patch.applicantName = input.applicantName;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.intake !== undefined) patch.intake = input.intake;

  const updated = await scope.db
    .update(applications)
    .set(patch)
    .where(scope.where(applications.organisationId, eq(applications.id, id)))
    .returning();
  const row = must(updated[0], 'application');

  if (
    input.applicantName !== undefined &&
    input.applicantName !== existing.applicantName
  ) {
    await writeApplicationSearchTokens(scope.db, scope.organisationId, {
      id: row.id,
      reference: row.reference,
      applicantName: row.applicantName,
    });
  }

  await recordAudit({
    action: 'application.updated',
    resourceType: 'application',
    resourceId: id,
    result: 'success',
    before: {
      data: {
        applicantName: existing.applicantName,
        priority: existing.priority,
      },
      allow: ['applicantName', 'priority'],
    },
    after: {
      data: { applicantName: row.applicantName, priority: row.priority },
      allow: ['applicantName', 'priority'],
    },
  });

  return row;
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

  const scope = currentScope();
  const priorAssignees = await activeAssigneeIds(id);
  const isReassignment = priorAssignees.length > 0;

  return scope.db.transaction(async (tx) => {
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
    const assignment = must(insertedAssignment[0], 'assignment');

    await tx
      .update(applications)
      .set({ currentAssigneeUserId: input.assigneeUserId })
      .where(
        and(
          eq(applications.organisationId, scope.organisationId),
          eq(applications.id, id),
        ),
      );

    await recordAudit({
      action: isReassignment ? 'assignment.reassigned' : 'assignment.assigned',
      resourceType: 'assignment',
      resourceId: assignment.id,
      result: 'success',
      after: {
        data: { applicationId: id, assigneeUserId: input.assigneeUserId },
        allow: ['applicationId', 'assigneeUserId'],
      },
    });

    return assignment;
  });
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
  const ctx = requireTenantContext();
  const subject: Subject = subjectFromContext(ctx);
  requireAny(subject, permissionsForAction(action));

  const input = transitionApplicationSchema.parse(rawInput);
  const existing = await loadApplication(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const from = existing.status as ApplicationStatus;
  // Throws ApplicationWorkflowError if the move is illegal from `from`.
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

  const updatedRows = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(applications)
      .set(patch)
      .where(scope.where(applications.organisationId, eq(applications.id, id)))
      .returning();

    await tx.insert(applicationStatusHistory).values(
      scope.insertValues({
        applicationId: id,
        fromStatus: from,
        toStatus: to,
        action,
        actorUserId: ctx.userId,
        note: input.note ?? null,
      }),
    );

    return updated;
  });
  const row = must(updatedRows[0], 'application');

  await recordAudit({
    action: TRANSITIONS[action].audit,
    resourceType: 'application',
    resourceId: id,
    result: 'success',
    reason: input.note ?? null,
    before: { data: { status: from }, allow: ['status'] },
    after: { data: { status: to, action }, allow: ['status', 'action'] },
  });

  return row;
}

/**
 * List applications within the tenant. Actors with `application:read-any` see
 * every application; everyone else sees only applications they are the
 * applicant on or actively assigned to.
 *
 * Text search is an equality lookup on blind-index tokens, then a keyset page
 * on `(created_at, id)` descending. Results stay in record order. Search does
 * not rank or score a person.
 */
export async function listApplications(
  rawInput: ListApplicationsInput = {},
): Promise<ApplicationListResult> {
  const ctx = requireTenantContext();
  const subject = subjectFromContext(ctx);
  const input = listApplicationsSchema.parse(rawInput);
  const scope = currentScope();
  const rawQuery = input.q?.trim() ?? '';
  const tokens = queryTokens(rawQuery);
  // A one-letter query is not indexed. Return no rows rather than the whole
  // register, which would look like the search had been ignored.
  if (rawQuery && tokens.length === 0) {
    return { items: [], limit: input.limit, offset: 0, nextCursor: null };
  }

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
    const createdAt = new Date(position.createdAt);
    filters.push(
      or(
        lt(applications.createdAt, createdAt),
        and(eq(applications.createdAt, createdAt), lt(applications.id, position.id)),
      ),
    );
  }
  if (tokens.length > 0) {
    await ensureSearchTokens(scope);
    for (const prefix of tokens) {
      const hashed = blindTokensForPrefix(scope.organisationId, prefix);
      filters.push(
        inArray(
          applications.id,
          scope.db
            .select({ id: applicationSearchTokens.applicationId })
            .from(applicationSearchTokens)
            .where(
              and(
                eq(applicationSearchTokens.organisationId, scope.organisationId),
                or(
                  eq(applicationSearchTokens.token, hashed.reference),
                  eq(applicationSearchTokens.token, hashed.name),
                ),
              ),
            ),
        ),
      );
    }
  }

  // Narrow to own/assigned/team unless the actor may read the whole tenant.
  if (!readsAllApplications(subject)) {
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
    .select()
    .from(applications)
    .where(scope.where(applications.organisationId, ...filters))
    .orderBy(desc(applications.createdAt), desc(applications.id))
    .limit(input.limit + 1)
    .offset(offset);

  const hasMore = rows.length > input.limit;
  const items = hasMore ? rows.slice(0, input.limit) : rows;
  const last = items.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeApplicationCursor({
          createdAt: last.createdAt.toISOString(),
          id: last.id,
        })
      : null;

  return { items, limit: input.limit, offset, nextCursor };
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
  const insertedNote = await scope.db
    .insert(applicationNotes)
    .values(
      scope.insertValues({
        applicationId: id,
        authorUserId: ctx.userId,
        body: input.body,
        visibility: input.visibility,
      }),
    )
    .returning();
  const note = must(insertedNote[0], 'note');

  await recordAudit({
    action: 'record.created',
    resourceType: 'record',
    resourceId: note.id,
    result: 'success',
    after: {
      data: { applicationId: id, visibility: input.visibility },
      allow: ['applicationId', 'visibility'],
    },
  });

  return note;
}

/** Re-export the context type for callers that thread it explicitly. */
export type { TenantContext };
