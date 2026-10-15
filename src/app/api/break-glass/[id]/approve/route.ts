import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';

import { approveBreakGlass } from '@/domains/break-glass';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/break-glass/[id]/approve — a tenant approver (break-glass:approve,
 * different from the requester) approves the grant. Requires step-up.
 */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/break-glass/[id]/approve']);
  const { id } = await params;
  const row = await withRequestTenant(() => approveBreakGlass(id));
  return NextResponse.json({ id: row.id, status: row.status });
});
