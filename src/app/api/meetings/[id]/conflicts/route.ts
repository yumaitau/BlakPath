import { NextResponse } from 'next/server';
import {
  declareConflict,
  listMeetingConflicts,
  type DeclareConflictInput,
} from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Conflicts of interest for cases on this meeting. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const conflicts = await withRequestTenant(() => listMeetingConflicts(id));
    return NextResponse.json({ conflicts });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json()) as DeclareConflictInput;
    const conflict = await withRequestTenant(() =>
      declareConflict({ ...body, meetingId: id }),
    );
    return NextResponse.json({ conflict }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
