import { NextResponse } from 'next/server';
import { sendCorrespondence } from '@/domains/correspondence';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Explicit human Send. Outcome letters are refused until the decision is
 * finalised. This route is the only way an outcome letter leaves the case.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; correspondenceId: string }> },
): Promise<Response> {
  try {
    const { correspondenceId } = await params;
    const correspondence = await withRequestTenant(() =>
      sendCorrespondence(correspondenceId),
    );
    return NextResponse.json({ correspondence });
  } catch (error) {
    return toErrorResponse(error);
  }
}
