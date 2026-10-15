import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { runApplicationImport } from '@/domains/imports';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/imports/applications — bulk legacy intake (max 100 rows).
 * Body: { rows: [{ applicantName, clientId?, priority?, intake? }], dryRun? }.
 * Requires `application:create`. Every created matter is individually audited.
 */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as unknown;
  const result = await withRequestTenant(() => runApplicationImport(body));
  return NextResponse.json(result, { status: 201 });
});
