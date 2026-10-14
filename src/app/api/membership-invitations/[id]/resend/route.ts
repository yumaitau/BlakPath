import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { resendMembershipInvitation } from '@/domains/memberships';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_WINDOWS.privileged);
  const { id } = await params;
  const result = await withRequestTenant(() => resendMembershipInvitation(id));
  return NextResponse.json({
    invitation: result.invitation,
    url: new URL(result.path, request.nextUrl.origin).toString(),
  });
});
