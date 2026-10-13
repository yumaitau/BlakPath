import { NextResponse } from 'next/server';
import { listOwnBreakGlassRequests } from '@/domains/break-glass';
import {
  breakGlassErrorResponse,
  requirePlatformOperatorIdentity,
} from '@/lib/http/platform-route';

/** GET /api/break-glass/mine — grants raised by the signed-in platform operator. */
export async function GET(): Promise<Response> {
  try {
    const { userId } = await requirePlatformOperatorIdentity();
    const items = await listOwnBreakGlassRequests(userId);
    return NextResponse.json({ items });
  } catch (error) {
    return breakGlassErrorResponse(error);
  }
}
