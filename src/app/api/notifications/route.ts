import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from '@/domains/notifications';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';

const patchSchema = z.union([
  z.object({ id: z.uuid() }),
  z.object({ all: z.literal(true) }),
]);

/** The signed-in member's tenant- and user-scoped inbox. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const payload = await withRequestTenant(async () => ({
    notifications: await listNotifications(),
    unreadCount: await unreadCount(),
  }));
  return NextResponse.json(payload);
});

/** Mark one notification, or every unread notification, as read. */
export const PATCH = tenantHandler(async function PATCH(
  request: Request,
): Promise<Response> {
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Invalid request');
  }

  const result = await withRequestTenant(async () => {
    if ('all' in parsed.data) {
      return { marked: await markAllRead() };
    }
    return { marked: (await markRead(parsed.data.id)) ? 1 : 0 };
  });
  return NextResponse.json(result);
});
