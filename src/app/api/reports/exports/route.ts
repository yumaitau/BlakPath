import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { listExports, requestExport, type RequestExportInput } from '@/domains/reporting';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * Export requests.
 * - GET  — list this tenant's export requests.
 * - POST — request an export ({ type, status?, from?, to? }); the worker assembles the CSV.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const items = await withRequestTenant(() => listExports());
  return NextResponse.json({ items });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/reports/exports']);
  const body: unknown = await request.json();
  // Validated (and type-enum enforced) by the zod schema inside requestExport.
  const row = await withRequestTenant(() => requestExport(body as RequestExportInput));
  return NextResponse.json({ id: row.id, type: row.type, status: row.status });
});
