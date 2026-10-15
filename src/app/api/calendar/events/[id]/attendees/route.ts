import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { addAttendee, type AddAttendeeInput } from '@/domains/calendar';
import { tenantHandler } from '@/lib/http/error-response';

/** POST /api/calendar/events/[id]/attendees — invite attendee. */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json()) as AddAttendeeInput;
  const row = await withRequestTenant(() => addAttendee(id, body));
  return NextResponse.json({ attendee: row }, { status: 201 });
});
