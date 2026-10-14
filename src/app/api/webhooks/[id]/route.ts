import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { deleteEndpoint } from '@/domains/webhooks';
import { tenantHandler } from '@/lib/http/error-response';

/** DELETE /api/webhooks/[id] — deactivate and remove a webhook endpoint. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  await withRequestTenant(() => deleteEndpoint(id));
  return NextResponse.json({ ok: true });
});
