import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { inviteAttendees } from '@/domains/calendar';

/** POST /api/calendar/events/[id]/invite — email email-only attendees. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const result = await withRequestTenant(() => inviteAttendees(id));
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
