import { relations } from 'drizzle-orm';
import { doublePrecision, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  rowVersion,
  softDelete,
  timestamps,
} from './_helpers';
import { boardTaskPriority, boardTaskStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { applications } from './applications';
import { tenantIsolationPolicy } from './_rls';

/**
 * Work-board task table (Kanban).
 *
 * A task is a unit of internal work that staff assign to one another and move
 * across board columns (todo → in_progress → blocked → done). Tenant-owned,
 * org-leading indexed. `position` is a fractional rank within a column so a
 * drag-and-drop reorder can slot a card between two others by averaging their
 * positions — no bulk renumber needed.
 *
 * PRODUCT INVARIANT: a task organises human work. It never scores, ranks or
 * determines a person's Aboriginality; an optional `applicationId` only links a
 * task to the matter it relates to.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    description: text('description'),
    status: boardTaskStatus('status').notNull().default('todo'),
    priority: boardTaskPriority('priority').notNull().default('normal'),
    /** Fractional rank within the status column (lower = higher on the board). */
    position: doublePrecision('position').notNull().default(0),
    assigneeUserId: refId('assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Optional link to the application this task relates to. */
    applicationId: refId('application_id').references(() => applications.id, {
      onDelete: 'set null',
    }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    ...timestamps,
    ...rowVersion,
    ...softDelete,
  },
  (table) => [
    index('tasks_org_status_position_idx').on(
      table.organisationId,
      table.status,
      table.position,
    ),
    index('tasks_org_assignee_idx').on(table.organisationId, table.assigneeUserId),
    tenantIsolationPolicy(),
  ],
).enableRLS();

export const tasksRelations = relations(tasks, ({ one }) => ({
  organisation: one(organisations, {
    fields: [tasks.organisationId],
    references: [organisations.id],
  }),
  assignee: one(users, {
    fields: [tasks.assigneeUserId],
    references: [users.id],
  }),
  createdBy: one(users, {
    fields: [tasks.createdByUserId],
    references: [users.id],
  }),
  application: one(applications, {
    fields: [tasks.applicationId],
    references: [applications.id],
  }),
}));
