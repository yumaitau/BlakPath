import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getEmailNotificationPreference,
  setEmailNotificationPreference,
} from '@/domains/notifications';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

const patchSchema = z.object({ emailNotifications: z.boolean() });

/** The signed-in member's email-copy preference for this tenant. */
export async function GET(): Promise<Response> {
  try {
    const emailNotifications = await withRequestTenant(() =>
      getEmailNotificationPreference(),
    );
    return NextResponse.json({ emailNotifications });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Turn the email copy on or off. In-app notices are not affected. */
export async function PATCH(request: Request): Promise<Response> {
  try {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const emailNotifications = await withRequestTenant(() =>
      setEmailNotificationPreference(parsed.data.emailNotifications),
    );
    return NextResponse.json({ emailNotifications });
  } catch (error) {
    return toErrorResponse(error);
  }
}
