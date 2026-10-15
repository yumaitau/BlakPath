import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { releaseHold } from '@/domains/retention';
import { tenantHandler } from '@/lib/http/error-response';

/** DELETE /api/retention/holds/[id] — release a legal hold. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['DELETE /api/retention/holds/[id]']);
  const { id } = await params;
  await withRequestTenant(() => releaseHold(id));
  return NextResponse.json({ ok: true });
});
