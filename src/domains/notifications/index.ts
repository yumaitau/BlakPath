/**
 * Notifications domain.
 *
 * Import from this barrel rather than reaching into `service` directly:
 *   - `createNotification` / `queueNotification` — insert an in-app record and,
 *     when the member wants email, enqueue its delivery job (worker-safe:
 *     uses `scopeFor`).
 *   - `getEmailNotificationPreference` / `setEmailNotificationPreference` —
 *     the current member's email-copy switch.
 *   - `markEmailed` — record that the worker dispatched the email copy.
 *   - `renderNotificationEmail` — pure template for the email copy.
 */
export {
  createNotification,
  getEmailNotificationPreference,
  listNotifications,
  markAllRead,
  markRead,
  markEmailed,
  queueNotification,
  setEmailNotificationPreference,
  unreadCount,
  renderNotificationEmail,
  type CreateNotificationInput,
  type NotificationListItem,
  type NotificationRow,
} from './service';
