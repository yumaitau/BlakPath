import { NextResponse } from 'next/server';
import { recordMinutes, type RecordMinutesInput } from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Store minutes written by a person. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const input = (await request.json()) as RecordMinutesInput;
    const meeting = await withRequestTenant(() => recordMinutes(id, input));
    return NextResponse.json({ meeting });
  } catch (error) {
    return toErrorResponse(error);
  }
}
