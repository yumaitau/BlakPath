import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { revokeBreakGlass } from '@/domains/break-glass';
import { tenantHandler } from '@/lib/http/error-response';

/** POST /api/break-glass/[id]/revoke — a tenant approver revokes the grant. */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/break-glass/[id]/revoke']);
  const { id } = await params;
  const row = await withRequestTenant(() => revokeBreakGlass(id));
  return NextResponse.json({ id: row.id, status: row.status });
});
