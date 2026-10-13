import { NextResponse } from 'next/server';
import {
  listAttendance,
  recordAttendance,
  type RecordAttendanceInput,
} from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Human attendance attestations. Not a quorum calculation. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const attendance = await withRequestTenant(() => listAttendance(id));
    return NextResponse.json({ attendance });
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
    const input = (await request.json()) as RecordAttendanceInput;
    const attendance = await withRequestTenant(() => recordAttendance(id, input));
    return NextResponse.json({ attendance });
  } catch (error) {
    return toErrorResponse(error);
  }
}
