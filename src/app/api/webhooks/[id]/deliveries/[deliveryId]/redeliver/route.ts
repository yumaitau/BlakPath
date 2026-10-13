import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { redeliverDelivery } from '@/domains/webhooks';

/**
 * POST /api/webhooks/[id]/deliveries/[deliveryId]/redeliver — re-send a
 * delivered or failed delivery (staff, `tenant:configure`; audited).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; deliveryId: string }> },
): Promise<Response> {
  try {
    const { id, deliveryId } = await params;
    const delivery = await withRequestTenant(() => redeliverDelivery(id, deliveryId));
    return NextResponse.json(
      { id: delivery.id, status: delivery.status, attempts: delivery.attempts },
      { status: 202 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
