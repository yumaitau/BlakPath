import { NextResponse } from 'next/server';
import { getTenantAiFeatures, setTenantAiFeatures } from '@/domains/mcp';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * Tenant AI-feature opt-in (organisation administrator, `tenant:configure`).
 *
 * POST requires step-up. Enabling also requires a governance reference and
 * statement, which are stored and audited. The JSON body cannot assert step-up;
 * the route sets that only after `requireRecentAuth` succeeds.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const status = await withRequestTenant(() => getTenantAiFeatures());
  return NextResponse.json(status);
});

export const POST = tenantHandler(async function POST(
  request: Request,
): Promise<Response> {
  await requireRecentAuth(STEP_UP_WINDOWS.privileged);
  const body: unknown = await request.json();
  const status = await withRequestTenant(() => setTenantAiFeatures(body, true));
  return NextResponse.json(status);
});
