import { NextResponse } from 'next/server';
import { removeAgendaItem } from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** Remove one case from a meeting agenda. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  const { itemId } = await params;
  await withRequestTenant(() => removeAgendaItem(itemId));
  return NextResponse.json({ ok: true });
});
