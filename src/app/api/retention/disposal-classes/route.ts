import { NextResponse } from 'next/server';
import { listDisposalCatalogue } from '@/domains/retention';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** GET /api/retention/disposal-classes — the catalogue a records manager signs. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const catalogue = await withRequestTenant(() => listDisposalCatalogue());
  return NextResponse.json(catalogue);
});
