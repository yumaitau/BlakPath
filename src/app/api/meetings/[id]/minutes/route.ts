import { NextResponse } from 'next/server';
import { recordMinutes, type RecordMinutesInput } from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** Store minutes written by a person. */
export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = (await request.json()) as RecordMinutesInput;
  const meeting = await withRequestTenant(() => recordMinutes(id, input));
  return NextResponse.json({ meeting });
});
