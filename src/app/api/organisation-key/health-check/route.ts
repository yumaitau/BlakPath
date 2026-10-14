import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runKeyHealthCheck } from '@/domains/organisation-keys';
import {
  requireRecentAuth,
  StepUpRequiredError,
  STEP_UP_WINDOWS,
} from '@/lib/auth/session';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

const healthCheckSchema = z.object({ restore: z.boolean().optional() }).strict();

/**
 * POST — check the active organisation's own key (organisation administrator,
 * step-up). `restore: true` returns an `unavailable` key to `active` only when
 * the check passes. The response carries no key material.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
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
  } catch (error) {
    if (error instanceof StepUpRequiredError) {
      return NextResponse.json(
        { error: 'Re-authentication required', code: 'STEP_UP_REQUIRED' },
        { status: 401 },
      );
    }
    return toErrorResponse(error);
  }
}
