import { NextResponse } from 'next/server';
import {
  listAttendance,
  recordAttendance,
  type RecordAttendanceInput,
} from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** Human attendance attestations. Not a quorum calculation. */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const attendance = await withRequestTenant(() => listAttendance(id));
  return NextResponse.json({ attendance });
});

export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = (await request.json()) as RecordAttendanceInput;
  const attendance = await withRequestTenant(() => recordAttendance(id, input));
  return NextResponse.json({ attendance });
});
