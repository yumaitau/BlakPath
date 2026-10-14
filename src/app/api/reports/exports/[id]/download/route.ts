import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { getExportDownloadUrl } from '@/domains/reporting';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/reports/exports/[id]/download — redirect to a ready export's CSV. */
export const GET = tenantHandler(async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['GET /api/reports/exports/[id]/download']);
  const { id } = await params;
  const { url } = await withRequestTenant(() => getExportDownloadUrl(id));
  if (request.headers.get('accept')?.includes('application/json')) {
    return NextResponse.json({ url });
  }
  return NextResponse.redirect(url);
});
