import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { reviewBreakGlass, type ReviewBreakGlassInput } from '@/domains/break-glass';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/break-glass/[id]/review — a tenant approver records the post-use
 * review. Notes are required. The requester cannot review their own grant.
 */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/break-glass/[id]/review']);
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
});
