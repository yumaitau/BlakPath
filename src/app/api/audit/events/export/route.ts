import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { exportAuditLog } from '@/domains/audit';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

function filterInput(request: NextRequest): Record<string, string> {
  const params = request.nextUrl.searchParams;
  const input: Record<string, string> = {};
  for (const key of [
    'case',
    'caseId',
    'user',
    'actorUserId',
    'action',
    'from',
    'to',
    'breakGlass',
    'denials',
  ]) {
    const value = params.get(key);
    if (value !== null) input[key] = value;
  }
  return input;
}

/** GET /api/audit/events/export — formula-safe CSV of the filtered trail. */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const exported = await withRequestTenant(() => exportAuditLog(filterInput(request)));
    return new NextResponse(exported.csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exported.filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Audit-Export-Truncated': exported.truncated ? 'true' : 'false',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
