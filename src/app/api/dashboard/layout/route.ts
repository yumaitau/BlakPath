import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { getDashboardLayout, saveDashboardLayout } from '@/domains/dashboard';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';

/**
 * GET/PUT the current user's dashboard widget order.
 *
 * A member may always arrange their own dashboard, so this is gated only by an
 * active tenant context (via `withRequestTenant`), not a data permission.
 */
const bodySchema = z.object({
  order: z.array(z.string().min(1).max(64)).max(50),
});

export const GET = tenantHandler(async function GET(): Promise<Response> {
  const order = await withRequestTenant(() => getDashboardLayout());
  return NextResponse.json({ order });
});

export const PUT = tenantHandler(async function PUT(
  request: NextRequest,
): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Invalid layout');
  }
  await withRequestTenant(() => saveDashboardLayout(parsed.data.order));
  return NextResponse.json({ ok: true });
});
