import { NextResponse } from 'next/server';
import {
  AiFeatureChangeError,
  getTenantAiFeatures,
  setTenantAiFeatures,
} from '@/domains/mcp';
import {
  requireRecentAuth,
  StepUpRequiredError,
  STEP_UP_WINDOWS,
} from '@/lib/auth/session';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Tenant AI-feature opt-in (organisation administrator, `tenant:configure`).
 *
 * POST requires step-up. Enabling also requires a governance reference and
 * statement, which are stored and audited. The JSON body cannot assert step-up;
 * the route sets that only after `requireRecentAuth` succeeds.
 */
export async function GET(): Promise<Response> {
  try {
    const status = await withRequestTenant(() => getTenantAiFeatures());
    return NextResponse.json(status);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.privileged);
    const body: unknown = await request.json();
    const status = await withRequestTenant(() => setTenantAiFeatures(body, true));
    return NextResponse.json(status);
  } catch (error) {
    if (
      error instanceof StepUpRequiredError ||
      (error instanceof AiFeatureChangeError && error.code === 'STEP_UP_REQUIRED')
    ) {
      return NextResponse.json(
        { error: 'Re-authentication required', code: 'STEP_UP_REQUIRED' },
        { status: 401 },
      );
    }
    if (error instanceof AiFeatureChangeError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    return toErrorResponse(error);
  }
}
