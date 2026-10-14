import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  OnboardingError,
  getTenantReadiness,
  recordTenantReadinessItem,
} from '@/domains/onboarding';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * GET/PATCH /api/organisation/readiness
 *
 * The signed-in administrator records onboarding checklist items. This does
 * not activate the organisation and does not record the services agreement.
 * Both of those stay with the operator command.
 */

const patchSchema = z.object({
  item: z.string().min(1).max(80),
  complete: z.boolean(),
});

export const GET = tenantHandler(async function GET(): Promise<Response> {
  const readiness = await withRequestTenant(() => getTenantReadiness());
  return NextResponse.json(readiness);
});

export const PATCH = tenantHandler(async function PATCH(
  request: NextRequest,
): Promise<Response> {
  const body = patchSchema.parse(await request.json().catch(() => null));
  try {
    const checklist = await withRequestTenant(() =>
      recordTenantReadinessItem(body.item, body.complete),
    );
    return NextResponse.json({ checklist });
  } catch (error) {
    if (error instanceof OnboardingError) {
      const status = error.code === 'UNKNOWN_CHECKLIST_ITEM' ? 400 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    throw error;
  }
});
