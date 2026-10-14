import { NextResponse } from 'next/server';

import { revokeMembershipInvitation } from '@/domains/memberships';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_WINDOWS.privileged);
  const { id } = await params;
  await withRequestTenant(() => revokeMembershipInvitation(id));
  return NextResponse.json({ ok: true });
});
