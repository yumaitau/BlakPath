import { NextResponse } from 'next/server';
import { listDisposalCatalogue } from '@/domains/retention';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** GET /api/retention/disposal-classes — the catalogue a records manager signs. */
export async function GET(): Promise<Response> {
  try {
    const catalogue = await withRequestTenant(() => listDisposalCatalogue());
    return NextResponse.json(catalogue);
  } catch (error) {
    return toErrorResponse(error);
  }
}
