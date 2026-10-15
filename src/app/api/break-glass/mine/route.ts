import { NextResponse } from 'next/server';
import { listOwnBreakGlassRequests } from '@/domains/break-glass';
import { tenantHandler } from '@/lib/http/error-response';
import { requirePlatformOperatorIdentity } from '@/lib/http/platform-route';

/** GET /api/break-glass/mine — grants raised by the signed-in platform operator. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const { userId } = await requirePlatformOperatorIdentity();
  const items = await listOwnBreakGlassRequests(userId);
  return NextResponse.json({ items });
});
