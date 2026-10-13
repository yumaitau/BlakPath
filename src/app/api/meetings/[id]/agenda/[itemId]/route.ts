import { NextResponse } from 'next/server';
import { removeAgendaItem } from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Remove one case from a meeting agenda. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  try {
    const { itemId } = await params;
    await withRequestTenant(() => removeAgendaItem(itemId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
