import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { activatePolicy } from '@/domains/retention';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * POST /api/retention/policies/[id]/activate
 * A different `retention:manage` holder from the drafter turns the policy on.
 * The drafter's own call is rejected. Requires step-up.
 */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/retention/policies/[id]/activate']);
  const { id } = await params;
  const row = await withRequestTenant(() => activatePolicy(id));
  return NextResponse.json({ id: row.id, active: row.active });
});
