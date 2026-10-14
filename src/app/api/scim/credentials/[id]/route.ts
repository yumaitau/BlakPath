import { NextResponse } from 'next/server';
import { revokeScimCredential } from '@/domains/scim';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/** DELETE /api/scim/credentials/[id] — revoke a SCIM credential immediately. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  await withRequestTenant(() => revokeScimCredential(id));
  return NextResponse.json({ ok: true });
});
