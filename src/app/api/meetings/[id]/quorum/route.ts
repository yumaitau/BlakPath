import { NextResponse } from 'next/server';
import { attestQuorum, type AttestQuorumInput } from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** A person attests whether quorum was present. */
export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = (await request.json()) as AttestQuorumInput;
  const meeting = await withRequestTenant(() => attestQuorum(id, input));
  return NextResponse.json({ meeting });
});
