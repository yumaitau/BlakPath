import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { confirmTenantPurge, type OffboardingConfirmInput } from '@/domains/privacy';

/**
 * POST { confirmSlug } — confirm the irreversible purge of every tenant row and
 * object. Allowed only after the export was downloaded; needs step-up.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.privileged);
    const { id } = await params;
    const body: unknown = await request.json();
    const row = await withRequestTenant(() =>
      confirmTenantPurge(id, body as OffboardingConfirmInput),
    );
    return NextResponse.json({ offboarding: row }, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
