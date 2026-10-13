import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import {
  listOffboardings,
  requestTenantOffboarding,
  type OffboardingConfirmInput,
} from '@/domains/privacy';

/** GET offboarding history / POST { confirmSlug } — export the whole tenant. */
export async function GET(): Promise<Response> {
  try {
    const items = await withRequestTenant(() => listOffboardings());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.privileged);
    const body: unknown = await request.json();
    const row = await withRequestTenant(() =>
      requestTenantOffboarding(body as OffboardingConfirmInput),
    );
    return NextResponse.json({ offboarding: row }, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
