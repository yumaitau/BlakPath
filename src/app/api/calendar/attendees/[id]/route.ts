import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { respondAttendee } from '@/domains/calendar';

/** PATCH /api/calendar/attendees/[id] — RSVP { responseStatus }. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = z
      .object({
        responseStatus: z.enum(['accepted', 'declined', 'tentative', 'needs-action']),
      })
      .parse(await request.json());
    const row = await withRequestTenant(() => respondAttendee(id, body.responseStatus));
    return NextResponse.json({ attendee: row });
  } catch (error) {
    return toErrorResponse(error);
  }
}
