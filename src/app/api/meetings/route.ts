import { NextResponse } from 'next/server';
import { createMeeting, listMeetings, type CreateMeetingInput } from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Committee meetings. GET lists; POST schedules one. */
export async function GET(): Promise<Response> {
  try {
    const meetings = await withRequestTenant(() => listMeetings());
    return NextResponse.json({ meetings });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = (await request.json()) as CreateMeetingInput;
    const meeting = await withRequestTenant(() => createMeeting(input));
    return NextResponse.json({ meeting }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
