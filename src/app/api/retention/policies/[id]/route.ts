import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { deletePolicy } from '@/domains/retention';

/** DELETE /api/retention/policies/[id] — deactivate a retention policy. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_ROUTES['DELETE /api/retention/policies/[id]']);
    const { id } = await params;
    await withRequestTenant(() => deletePolicy(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
