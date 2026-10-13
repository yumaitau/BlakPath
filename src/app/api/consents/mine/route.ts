import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { listMyConsents } from '@/domains/consent';

/** GET /api/consents/mine — the signed-in person's own consents (portal). */
export async function GET(): Promise<Response> {
  try {
    const rows = await withRequestTenant(() => listMyConsents());
    return NextResponse.json({ consents: rows });
  } catch (error) {
    return toErrorResponse(error);
  }
}
