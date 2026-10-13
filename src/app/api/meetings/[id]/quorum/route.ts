import { NextResponse } from 'next/server';
import { attestQuorum, type AttestQuorumInput } from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** A person attests whether quorum was present. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const input = (await request.json()) as AttestQuorumInput;
    const meeting = await withRequestTenant(() => attestQuorum(id, input));
    return NextResponse.json({ meeting });
  } catch (error) {
    return toErrorResponse(error);
  }
}
