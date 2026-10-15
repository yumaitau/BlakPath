import { NextResponse } from 'next/server';
import { sendCorrespondence } from '@/domains/correspondence';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Explicit human Send. Outcome letters are refused until the decision is
 * finalised. This route is the only way an outcome letter leaves the case.
 * Sending releases case information to the applicant, so it needs a fresh
 * sign-in.
 */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; correspondenceId: string }> },
): Promise<Response> {
  await requireRecentAuth(
    STEP_UP_ROUTES['POST /api/applications/[id]/correspondence/[correspondenceId]/send'],
  );
  const { correspondenceId } = await params;
  const correspondence = await withRequestTenant(() =>
    sendCorrespondence(correspondenceId),
  );
  return NextResponse.json({ correspondence });
});
