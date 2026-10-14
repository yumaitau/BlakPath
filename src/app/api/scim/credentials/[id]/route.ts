import { NextResponse } from 'next/server';
import { revokeScimCredential } from '@/domains/scim';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** DELETE /api/scim/credentials/[id] — revoke a SCIM credential immediately. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    await withRequestTenant(() => revokeScimCredential(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
