import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { releaseHold } from '@/domains/retention';
import { tenantHandler } from '@/lib/http/error-response';

/** DELETE /api/retention/holds/[id] — release a legal hold. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  await withRequestTenant(() => releaseHold(id));
  return NextResponse.json({ ok: true });
});
