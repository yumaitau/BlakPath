import { NextResponse } from 'next/server';
import { getMeetingPack } from '@/domains/meetings';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * GET /api/meetings/[id]/pack — confidential pack.
 * Releasing the pack needs a fresh session, then `meeting:pack-access`. Both a
 * view and a refusal are audited.
 */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['GET /api/meetings/[id]/pack']);
  const { id } = await params;
  const pack = await withRequestTenant(() => getMeetingPack(id));
  return NextResponse.json({ pack });
});
