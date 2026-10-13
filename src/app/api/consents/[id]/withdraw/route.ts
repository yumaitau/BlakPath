import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { withdrawConsent, type WithdrawConsentInput } from '@/domains/consent';

/**
 * POST /api/consents/[id]/withdraw — withdraw a grant.
 *
 * `method: 'online-acknowledgement'` is the subject (or their representative)
 * withdrawing through the portal; any other method is staff recording a
 * withdrawal given on paper, verbally or in writing. Appends a withdrawal
 * event, runs downstream effects (e.g. revokes representative access) and is
 * audited.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json()) as WithdrawConsentInput;
    const result = await withRequestTenant(() => withdrawConsent(id, body));
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
