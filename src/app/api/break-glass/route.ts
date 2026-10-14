import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { requirePlatformOperator } from '@/lib/http/platform-route';
import {
  listBreakGlassRequests,
  requestBreakGlass,
  type RequestBreakGlassInput,
} from '@/domains/break-glass';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * - GET  — list this organisation's break-glass requests (tenant approver).
 * - POST — a PLATFORM operator requests emergency access to an organisation
 *          (requires step-up; the operator flag is verified against the DB).
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const items = await withRequestTenant(() => listBreakGlassRequests());
  return NextResponse.json({ items });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const { userId } = await requirePlatformOperator(
    STEP_UP_ROUTES['POST /api/break-glass'],
  );
  const body: unknown = await request.json();
  const row = await requestBreakGlass({
    requestedByUserId: userId,
    correlationId: globalThis.crypto.randomUUID(),
    input: body as RequestBreakGlassInput,
  });
  return NextResponse.json({ id: row.id, status: row.status });
});
