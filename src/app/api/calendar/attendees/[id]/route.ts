import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { respondAttendee } from '@/domains/calendar';
import { tenantHandler } from '@/lib/http/error-response';

/** PATCH /api/calendar/attendees/[id] — RSVP { responseStatus }. */
export const PATCH = tenantHandler(async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = z
    .object({
      responseStatus: z.enum(['accepted', 'declined', 'tentative', 'needs-action']),
    })
    .parse(await request.json());
  const row = await withRequestTenant(() => respondAttendee(id, body.responseStatus));
  return NextResponse.json({ attendee: row });
});
