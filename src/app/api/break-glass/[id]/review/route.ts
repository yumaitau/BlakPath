import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { reviewBreakGlass, type ReviewBreakGlassInput } from '@/domains/break-glass';

/**
 * POST /api/break-glass/[id]/review — a tenant approver records the post-use
 * review. Notes are required. The requester cannot review their own grant.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body: unknown = await request.json();
    const row = await withRequestTenant(() =>
      reviewBreakGlass(id, body as ReviewBreakGlassInput),
    );
    return NextResponse.json({
      id: row.id,
      status: row.status,
      reviewedAt: row.reviewedAt,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
