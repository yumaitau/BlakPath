import { NextResponse } from 'next/server';
import {
  sendEvidenceRequestNotice,
  type NotifyEvidenceRequestInput,
} from '@/domains/correspondence';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Human send of an evidence-request notice, including the due date.
 * Creating the request does not call this.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> },
): Promise<Response> {
  try {
    const { id, requestId } = await params;
    const body = (await request.json()) as NotifyEvidenceRequestInput;
    const correspondence = await withRequestTenant(() =>
      sendEvidenceRequestNotice(id, requestId, body),
    );
    return NextResponse.json({ correspondence }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
