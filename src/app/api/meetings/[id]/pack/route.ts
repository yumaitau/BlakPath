import { NextResponse } from 'next/server';
import { getMeetingPack } from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * GET /api/meetings/[id]/pack — confidential pack.
 * `meeting:pack-access` is required. Both a view and a refusal are audited.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const pack = await withRequestTenant(() => getMeetingPack(id));
    return NextResponse.json({ pack });
  } catch (error) {
    return toErrorResponse(error);
  }
}
