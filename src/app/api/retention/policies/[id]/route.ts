import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { deletePolicy } from '@/domains/retention';
import { tenantHandler } from '@/lib/http/error-response';

/** DELETE /api/retention/policies/[id] — deactivate a retention policy. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  await withRequestTenant(() => deletePolicy(id));
  return NextResponse.json({ ok: true });
});
