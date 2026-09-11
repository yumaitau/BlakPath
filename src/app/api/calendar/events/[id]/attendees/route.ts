import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { addAttendee, type AddAttendeeInput } from '@/domains/calendar';

/** POST /api/calendar/events/[id]/attendees — invite attendee. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json()) as AddAttendeeInput;
    const row = await withRequestTenant(() => addAttendee(id, body));
    return NextResponse.json({ attendee: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
