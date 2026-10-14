import { NextResponse } from 'next/server';
import { withdrawConsent } from '@/domains/consent';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** DELETE /api/consents/[id] — record that a person withdrew a grant. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    await withRequestTenant(() => withdrawConsent(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
