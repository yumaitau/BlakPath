import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { createEndpoint, listEndpoints } from '@/domains/webhooks';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * Webhook endpoint management (staff, `tenant:configure`).
 * - GET  — list endpoints. The signing secret is never included.
 * - POST — register an endpoint; the generated signing secret is returned once.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const items = await withRequestTenant(() => listEndpoints());
  return NextResponse.json({ items });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/webhooks']);
  const body: unknown = await request.json();
  const created = await withRequestTenant(() =>
    createEndpoint(body as { url: string; events: string[] }),
  );
  return NextResponse.json({
    id: created.id,
    url: created.url,
    events: created.events,
    secret: created.secret,
  });
});
