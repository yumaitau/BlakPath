import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { createEndpoint, listEndpoints } from '@/domains/webhooks';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * Webhook endpoint management (staff, `tenant:configure`).
 * - GET  — list endpoints (includes the signing secret so it can be configured).
 * - POST — register an endpoint; the generated signing secret is returned.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const items = await withRequestTenant(() => listEndpoints());
  return NextResponse.json({ items });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body: unknown = await request.json();
  const endpoint = await withRequestTenant(() =>
    createEndpoint(body as { url: string; events: string[] }),
  );
  return NextResponse.json({
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    secret: endpoint.secret,
  });
});
