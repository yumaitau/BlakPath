import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { inviteAttendees } from '@/domains/calendar';
import { tenantHandler } from '@/lib/http/error-response';

/** POST /api/calendar/events/[id]/invite — email email-only attendees. */
export const POST = tenantHandler(async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const result = await withRequestTenant(() => inviteAttendees(id));
  return NextResponse.json(result);
});
