import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { listExports, requestExport, type RequestExportInput } from '@/domains/reporting';

/**
 * Export requests.
 * - GET  — list this tenant's export requests.
 * - POST — request an export ({ type, status?, from?, to? }); the worker assembles the CSV.
 */
export async function GET(): Promise<Response> {
  try {
    const items = await withRequestTenant(() => listExports());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body: unknown = await request.json();
    // Validated (and type-enum enforced) by the zod schema inside requestExport.
    const row = await withRequestTenant(() => requestExport(body as RequestExportInput));
    return NextResponse.json({ id: row.id, type: row.type, status: row.status });
  } catch (error) {
    return toErrorResponse(error);
  }
}
