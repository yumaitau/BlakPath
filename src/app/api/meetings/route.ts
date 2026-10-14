import { NextResponse } from 'next/server';
import { createMeeting, listMeetings, type CreateMeetingInput } from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** Committee meetings. GET lists; POST schedules one. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const meetings = await withRequestTenant(() => listMeetings());
  return NextResponse.json({ meetings });
});

export const POST = tenantHandler(async function POST(
  request: Request,
): Promise<Response> {
  const input = (await request.json()) as CreateMeetingInput;
  const meeting = await withRequestTenant(() => createMeeting(input));
  return NextResponse.json({ meeting }, { status: 201 });
});
