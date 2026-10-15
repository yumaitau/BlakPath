import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { revokeApiKey } from '@/domains/api-keys';
import { tenantHandler } from '@/lib/http/error-response';

/** DELETE /api/keys/[id] — revoke an API key immediately. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  await withRequestTenant(() => revokeApiKey(id));
  return NextResponse.json({ ok: true });
});
