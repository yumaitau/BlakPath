import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { requestErasure } from '@/domains/privacy';

/**
 * POST — queue the anonymisation of the request's subject outside official
 * records and legal holds. The worker runs it and saves a report on the
 * request. Irreversible, so it needs a privileged step-up.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.privileged);
    const { id } = await params;
    await withRequestTenant(() => requestErasure(id));
    return NextResponse.json({ queued: true }, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
