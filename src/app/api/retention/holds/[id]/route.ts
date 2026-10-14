import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { releaseHold } from '@/domains/retention';

/** DELETE /api/retention/holds/[id] — release a legal hold. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_ROUTES['DELETE /api/retention/holds/[id]']);
    const { id } = await params;
    await withRequestTenant(() => releaseHold(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
