import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { redeliverDelivery } from '@/domains/webhooks';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/webhooks/[id]/deliveries/[deliveryId]/redeliver — re-send a
 * delivered or failed delivery (staff, `tenant:configure`, fresh session;
 * audited).
 */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; deliveryId: string }> },
): Promise<Response> {
  await requireRecentAuth(
    STEP_UP_ROUTES['POST /api/webhooks/[id]/deliveries/[deliveryId]/redeliver'],
  );
  const { id, deliveryId } = await params;
  const delivery = await withRequestTenant(() => redeliverDelivery(id, deliveryId));
  return NextResponse.json(
    { id: delivery.id, status: delivery.status, attempts: delivery.attempts },
    { status: 202 },
  );
});
