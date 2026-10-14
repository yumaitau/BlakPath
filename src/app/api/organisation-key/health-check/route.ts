import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runKeyHealthCheck } from '@/domains/organisation-keys';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

const healthCheckSchema = z.object({ restore: z.boolean().optional() }).strict();

/**
 * POST — check the active organisation's own key (organisation administrator,
 * step-up). `restore: true` returns an `unavailable` key to `active` only when
 * the check passes. The response carries no key material.
 */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  await requireRecentAuth(STEP_UP_WINDOWS.privileged);
  const body = healthCheckSchema.parse(await request.json().catch(() => ({})));
  const outcome = await withRequestTenant(() =>
    runKeyHealthCheck({ restore: body.restore === true }),
  );
  return NextResponse.json({
    ok: outcome.ok,
    checkedAt: outcome.checkedAt.toISOString(),
    failure: outcome.failure,
    restored: outcome.restored,
  });
});
