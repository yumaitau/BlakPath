import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { getExportDownloadUrl } from '@/domains/reporting';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/reports/exports/[id]/download — redirect to a ready export's CSV. */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { url } = await withRequestTenant(() => getExportDownloadUrl(id));
  return NextResponse.redirect(url);
});
