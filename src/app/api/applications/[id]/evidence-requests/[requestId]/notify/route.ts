import { NextResponse } from 'next/server';
import {
  sendEvidenceRequestNotice,
  type NotifyEvidenceRequestInput,
} from '@/domains/correspondence';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Human send of an evidence-request notice, including the due date.
 * Creating the request does not call this. Sending releases case information
 * to the applicant, so it needs a fresh sign-in.
 */
export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> },
): Promise<Response> {
  await requireRecentAuth(
    STEP_UP_ROUTES['POST /api/applications/[id]/evidence-requests/[requestId]/notify'],
  );
  const { id, requestId } = await params;
  const body = (await request.json()) as NotifyEvidenceRequestInput;
  const correspondence = await withRequestTenant(() =>
    sendEvidenceRequestNotice(id, requestId, body),
  );
  return NextResponse.json({ correspondence }, { status: 201 });
});
