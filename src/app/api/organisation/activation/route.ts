import { NextResponse } from 'next/server';
import { activateCurrentOrganisation } from '@/domains/organisation-keys/activation';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

export async function POST(): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.privileged);
    const organisation = await withRequestTenant(() => activateCurrentOrganisation());
    return NextResponse.json({ organisation });
  } catch (error) {
    return toErrorResponse(error);
  }
}
