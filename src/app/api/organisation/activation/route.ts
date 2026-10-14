import { NextResponse } from 'next/server';
import { activateCurrentOrganisation } from '@/domains/organisation-keys/activation';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

export const POST = tenantHandler(async function POST(): Promise<Response> {
  await requireRecentAuth(STEP_UP_WINDOWS.privileged);
  const organisation = await withRequestTenant(() => activateCurrentOrganisation());
  return NextResponse.json({ organisation });
});
