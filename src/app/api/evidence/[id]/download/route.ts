import { getDownloadUrl } from '@/domains/evidence';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const download = await withRequestTenant(() => getDownloadUrl(id));
  return Response.redirect(download.url, 302);
});
