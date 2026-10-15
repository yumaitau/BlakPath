import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getEmailNotificationPreference,
  setEmailNotificationPreference,
} from '@/domains/notifications';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';

const patchSchema = z.object({ emailNotifications: z.boolean() });

/** The signed-in member's email-copy preference for this tenant. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const emailNotifications = await withRequestTenant(() =>
    getEmailNotificationPreference(),
  );
  return NextResponse.json({ emailNotifications });
});

/** Turn the email copy on or off. In-app notices are not affected. */
export const PATCH = tenantHandler(async function PATCH(
  request: Request,
): Promise<Response> {
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Invalid request');
  }
  const emailNotifications = await withRequestTenant(() =>
    setEmailNotificationPreference(parsed.data.emailNotifications),
  );
  return NextResponse.json({ emailNotifications });
});
