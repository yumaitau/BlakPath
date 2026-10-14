import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { listDeliveries } from '@/domains/webhooks';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/webhooks/[id]/deliveries — recent delivery attempts for an endpoint. */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const items = await withRequestTenant(() => listDeliveries(id));
  return NextResponse.json({ items });
});
