import type { Metadata } from 'next';
import { NotificationList } from '@/components/notifications/notification-list';

export const metadata: Metadata = {
  title: 'Notifications — BlakPath',
};

export default function NotificationsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
      <p className="text-muted-foreground mt-2">
        Updates about work in your current organisation.
      </p>
      <div className="border-border bg-surface mt-6 rounded-lg border p-4 sm:p-5">
        <NotificationList />
      </div>
    </div>
  );
}
