import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { notifications } from '@/db/schema';
import { currentScope, scopeFor } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { requireTenantContext } from '@/lib/tenancy/context';
import { addJob, QueueName } from '@/lib/queues';
export { renderNotificationEmail } from './templates';

/**
 * Notifications service.
 *
 * A notification is a durable, in-app record that something needs a member's
 * attention. Creating one also enqueues a Notification job so the worker can
 * deliver an email copy that simply points the member back into the app — never
 * a bearer link.
 *
 * These functions run from BOTH domain services and the worker, so they use
 * `scopeFor(organisationId)` (an explicit tenant scope) rather than the ambient
 * `currentScope()`, which does not exist in the worker.
 */

export type NotificationRow = typeof notifications.$inferSelect;

/** Safe, user-facing projection. Never exposes tenant or recipient identifiers. */
export type NotificationListItem = Pick<
  NotificationRow,
  | 'id'
  | 'type'
  | 'title'
  | 'body'
  | 'resourceType'
  | 'resourceId'
  | 'readAt'
  | 'createdAt'
>;

export interface CreateNotificationInput {
  organisationId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  resourceType?: string;
  resourceId?: string;
}

/**
 * Insert a notification row and enqueue its email-delivery job. The job is keyed
 * by the notification id so a retry cannot double-schedule delivery.
 */
export async function createNotification(
  input: CreateNotificationInput,
  correlationId: string,
): Promise<NotificationRow> {
  const scope = scopeFor(input.organisationId);
  const id = uuidv7();
  const inserted = await scope.db
    .insert(notifications)
    .values(
      scope.insertValues({
        id,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
      }),
    )
    .returning();
  const row = expectRow(inserted[0], 'notification row');

  await addJob(
    QueueName.Notification,
    'deliver',
    {
      organisationId: input.organisationId,
      correlationId,
      notificationId: id,
    },
    { jobId: id },
  );

  return row;
}

/** Convenience wrapper matching the `queue*` naming used elsewhere. */
export function queueNotification(
  input: CreateNotificationInput,
  correlationId: string,
): Promise<NotificationRow> {
  return createNotification(input, correlationId);
}

/** Mark that an email copy has been dispatched for a notification. */
export async function markEmailed(
  organisationId: string,
  notificationId: string,
): Promise<void> {
  const scope = scopeFor(organisationId);
  await scope.db
    .update(notifications)
    .set({ emailedAt: new Date() })
    .where(
      and(
        eq(notifications.organisationId, organisationId),
        eq(notifications.id, notificationId),
      ),
    );
}

/**
 * List the current member's notifications in their active tenant. The user id
 * comes only from the verified tenant context, so a browser can never request
 * another member's inbox.
 */
export async function listNotifications(limit = 50): Promise<NotificationListItem[]> {
  const ctx = requireTenantContext();
  const scope = currentScope();
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);

  return scope.db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      resourceType: notifications.resourceType,
      resourceId: notifications.resourceId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(
      scope.where(notifications.organisationId, eq(notifications.userId, ctx.userId)),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(safeLimit);
}

/** Count unread notifications for the current member and tenant. */
export async function unreadCount(): Promise<number> {
  const ctx = requireTenantContext();
  const scope = currentScope();
  const rows = await scope.db
    .select({ count: count() })
    .from(notifications)
    .where(
      scope.where(
        notifications.organisationId,
        eq(notifications.userId, ctx.userId),
        isNull(notifications.readAt),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Mark one of the current member's unread notifications as read. A missing,
 * already-read, or another-member notification all return false to avoid
 * revealing anything outside the caller's own scoped inbox.
 */
export async function markRead(id: string): Promise<boolean> {
  const ctx = requireTenantContext();
  const scope = currentScope();
  const updated = await scope.db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      scope.where(
        notifications.organisationId,
        eq(notifications.userId, ctx.userId),
        eq(notifications.id, id),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  return updated.length === 1;
}

/** Mark every unread notification in the current member's tenant inbox as read. */
export async function markAllRead(): Promise<number> {
  const ctx = requireTenantContext();
  const scope = currentScope();
  const updated = await scope.db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      scope.where(
        notifications.organisationId,
        eq(notifications.userId, ctx.userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  return updated.length;
}
