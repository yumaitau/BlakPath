import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { listAuditLog } from '@/domains/audit';
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
    'limit',
    'offset',
  ]) {
    const value = params.get(key);
    if (value !== null) input[key] = value;
  }
  return input;
}

/** GET /api/audit/events — one page of the active tenant's audit trail. */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const page = await withRequestTenant(() => listAuditLog(filterInput(request)));
    return NextResponse.json(page);
  } catch (error) {
    return toErrorResponse(error);
  }
}
