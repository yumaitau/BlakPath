import { NextResponse } from 'next/server';
import {
  declareConflict,
  listMeetingConflicts,
  type DeclareConflictInput,
} from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** Conflicts of interest for cases on this meeting. */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const conflicts = await withRequestTenant(() => listMeetingConflicts(id));
  return NextResponse.json({ conflicts });
});

export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json()) as DeclareConflictInput;
  const conflict = await withRequestTenant(() =>
    declareConflict({ ...body, meetingId: id }),
  );
  return NextResponse.json({ conflict }, { status: 201 });
});
