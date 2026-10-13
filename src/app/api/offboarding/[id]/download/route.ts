import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { getOffboardingExportUrl } from '@/domains/privacy';

/** POST — a short-lived download URL for the tenant export. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.sensitiveAction);
    const { id } = await params;
    const signed = await withRequestTenant(() => getOffboardingExportUrl(id));
    return NextResponse.json(signed);
  } catch (error) {
    return toErrorResponse(error);
  }
}
