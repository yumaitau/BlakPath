import { NextResponse } from 'next/server';
import { requirePlatformOperator } from '@/lib/http/platform-route';
import { activateBreakGlass } from '@/domains/break-glass';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/break-glass/[id]/activate — the requesting platform operator
 * activates an approved grant (requires step-up; notifies the tenant).
 */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { userId } = await requirePlatformOperator();
  const { id } = await params;
  const row = await activateBreakGlass({
    requestId: id,
    activatingUserId: userId,
    correlationId: globalThis.crypto.randomUUID(),
  });
  return NextResponse.json({ id: row.id, status: row.status });
});
