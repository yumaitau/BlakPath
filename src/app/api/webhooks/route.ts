import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { createEndpoint, listEndpoints } from '@/domains/webhooks';

/**
 * Webhook endpoint management (staff, `tenant:configure`).
 * - GET  — list endpoints. The signing secret is never included.
 * - POST — register an endpoint; the generated signing secret is returned once.
 */
export async function GET(): Promise<Response> {
  try {
    const items = await withRequestTenant(() => listEndpoints());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
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
  } catch (error) {
    return toErrorResponse(error);
  }
}
