import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { previewRetention } from '@/domains/retention';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/retention/preview — dry-run counts for the active policies. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const items = await withRequestTenant(() => previewRetention());
  return NextResponse.json({ items });
});
