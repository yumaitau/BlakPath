import { asc, eq, isNull, sql } from 'drizzle-orm';
import { tasks, users } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requireAny, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { positionBetween, type BoardColumn } from './board';
import {
  assignTaskSchema,
  createTaskSchema,
  moveTaskSchema,
  updateTaskSchema,
  type AssignTaskInput,
  type CreateTaskInput,
  type MoveTaskInput,
  type UpdateTaskInput,
} from './schemas';

/**
 * Work-board (tasks) service — tenant-scoped, permission-checked, audited.
 *
 * Staff create tasks, assign them, and drag them across columns. Reads require
 * an application-read capability; every mutation requires the ability to work a
 * matter (`application:read-any` or `application:assign`). All state changes go
 * through this file so the tenant guard and the audit trail are never skipped.
 *
 * PRODUCT INVARIANT: a task organises human work. It never scores, ranks or
 * determines a person's Aboriginality; an optional `applicationId` only records
 * which matter the work relates to.
 */

export type TaskRow = typeof tasks.$inferSelect;

/** Capabilities that permit reading the board. */
const TASK_READ = ['application:read-assigned', 'application:read-any'] as const;

/** Capabilities that permit changing the board. */
const TASK_WRITE = ['application:read-any', 'application:assign'] as const;

/** Load a single live task within the active tenant, or null. */
async function loadTask(id: string): Promise<TaskRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(tasks)
    .where(scope.where(tasks.organisationId, eq(tasks.id, id), isNull(tasks.deletedAt)))
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

/** List every live task in the tenant, ordered by column then rank. */
export async function listTasks(): Promise<TaskRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TASK_READ);

  const scope = currentScope();
  return scope.db
    .select()
    .from(tasks)
    .where(scope.where(tasks.organisationId, isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.status), asc(tasks.position));
}

/** A board task enriched with its assignee's display name (for the UI). */
export interface BoardTaskView extends TaskRow {
  assigneeName: string | null;
}

/**
 * List live tasks with the assignee's display name resolved via a left join, so
 * the board can show who holds each card without a second round-trip.
 */
export async function listBoardTasks(): Promise<BoardTaskView[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TASK_READ);

  const scope = currentScope();
  const rows = await scope.db
    .select({ task: tasks, assigneeName: users.name })
    .from(tasks)
    .leftJoin(users, eq(tasks.assigneeUserId, users.id))
    .where(scope.where(tasks.organisationId, isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.status), asc(tasks.position));

  return rows.map((r) => ({ ...r.task, assigneeName: r.assigneeName ?? null }));
}

/** The next free position at the bottom of a column (max + 1, or 0 if empty). */
async function nextPositionInColumn(status: BoardColumn): Promise<number> {
  const scope = currentScope();
  const rows = await scope.db
    .select({ max: sql<number | null>`max(${tasks.position})` })
    .from(tasks)
    .where(
      scope.where(
        tasks.organisationId,
        eq(tasks.status, status),
        isNull(tasks.deletedAt),
      ),
    );
  const currentMax = rows[0]?.max ?? null;
  return currentMax === null ? 0 : currentMax + 1;
}

/** Create a task, appended to the bottom of its column. */
export async function createTask(rawInput: CreateTaskInput): Promise<TaskRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TASK_WRITE);

  const input = createTaskSchema.parse(rawInput);
  const status: BoardColumn = 'todo';
  const position = await nextPositionInColumn(status);

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(tasks)
      .values(
        scope.insertValues({
          title: input.title,
          status,
          position,
          createdByUserId: ctx.userId,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.assigneeUserId !== undefined
            ? { assigneeUserId: input.assigneeUserId }
            : {}),
          ...(input.applicationId !== undefined
            ? { applicationId: input.applicationId }
            : {}),
          ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        }),
      )
      .returning();
    const row = expectRow(inserted[0], 'task');

    await recordAudit(
      {
        action: 'task.created',
        resourceType: 'task',
        resourceId: row.id,
        result: 'success',
        after: { data: { title: row.title }, allow: ['title'] },
      },
      tx,
    );

    return row;
  });
}

/** Edit a task's fields. */
export async function updateTask(
  id: string,
  rawInput: UpdateTaskInput,
): Promise<TaskRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TASK_WRITE);

  const input = updateTaskSchema.parse(rawInput);
  const existing = await loadTask(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(tasks)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.assigneeUserId !== undefined
          ? { assigneeUserId: input.assigneeUserId }
          : {}),
        ...(input.applicationId !== undefined
          ? { applicationId: input.applicationId }
          : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      })
      .where(scope.where(tasks.organisationId, eq(tasks.id, id)))
      .returning();
    const row = expectRow(updated[0], 'task');

    await recordAudit(
      {
        action: 'task.updated',
        resourceType: 'task',
        resourceId: id,
        result: 'success',
        after: { data: { title: row.title }, allow: ['title'] },
      },
      tx,
    );

    return row;
  });
}

/** Assign a task to someone, or clear the assignee with `null`. */
export async function assignTask(
  id: string,
  rawInput: AssignTaskInput,
): Promise<TaskRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TASK_WRITE);

  const input = assignTaskSchema.parse(rawInput);
  const existing = await loadTask(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(tasks)
      .set({ assigneeUserId: input.assigneeUserId })
      .where(scope.where(tasks.organisationId, eq(tasks.id, id)))
      .returning();
    const row = expectRow(updated[0], 'task');

    await recordAudit(
      {
        action: 'task.assigned',
        resourceType: 'task',
        resourceId: id,
        result: 'success',
        after: {
          data: { assigneeUserId: input.assigneeUserId },
          allow: ['assigneeUserId'],
        },
      },
      tx,
    );

    return row;
  });
}

/** Read one live task's position within the tenant, or undefined. */
async function positionOf(id: string, status: BoardColumn): Promise<number | undefined> {
  const scope = currentScope();
  const rows = await scope.db
    .select({ position: tasks.position })
    .from(tasks)
    .where(
      scope.where(
        tasks.organisationId,
        eq(tasks.id, id),
        eq(tasks.status, status),
        isNull(tasks.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.position;
}

/**
 * Move a task to a column and slot it between its dropped neighbours. Neighbour
 * positions are read from the TARGET column within this tenant, so a stale or
 * cross-column id simply contributes no bound.
 */
export async function moveTask(id: string, rawInput: MoveTaskInput): Promise<TaskRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TASK_WRITE);

  const input = moveTaskSchema.parse(rawInput);
  const existing = await loadTask(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const before = input.beforeId
    ? await positionOf(input.beforeId, input.status)
    : undefined;
  const after = input.afterId ? await positionOf(input.afterId, input.status) : undefined;
  const position = positionBetween(before, after);

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(tasks)
      .set({ status: input.status, position })
      .where(scope.where(tasks.organisationId, eq(tasks.id, id)))
      .returning();
    const row = expectRow(updated[0], 'task');

    await recordAudit(
      {
        action: 'task.moved',
        resourceType: 'task',
        resourceId: id,
        result: 'success',
        after: { data: { status: input.status }, allow: ['status'] },
      },
      tx,
    );

    return row;
  });
}

/** Mark a task done. */
export async function completeTask(id: string): Promise<TaskRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TASK_WRITE);

  const existing = await loadTask(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(tasks)
      .set({ status: 'done' })
      .where(scope.where(tasks.organisationId, eq(tasks.id, id)))
      .returning();
    const row = expectRow(updated[0], 'task');

    await recordAudit(
      {
        action: 'task.completed',
        resourceType: 'task',
        resourceId: id,
        result: 'success',
      },
      tx,
    );

    return row;
  });
}

/** Soft-delete a task (removes it from the board; the row is retained). */
export async function deleteTask(id: string): Promise<void> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TASK_WRITE);

  const existing = await loadTask(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  await scope.db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(scope.where(tasks.organisationId, eq(tasks.id, id)));

    await recordAudit(
      {
        action: 'task.deleted',
        resourceType: 'task',
        resourceId: id,
        result: 'success',
      },
      tx,
    );
  });
}
