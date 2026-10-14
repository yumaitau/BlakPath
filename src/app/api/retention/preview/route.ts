import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { previewRetention } from '@/domains/retention';

/** GET /api/retention/preview — dry-run counts for the active policies. */
export async function GET(): Promise<Response> {
  try {
    const items = await withRequestTenant(() => previewRetention());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}
