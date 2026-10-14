import { getDownloadUrl } from '@/domains/evidence';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_ROUTES['GET /api/evidence/[id]/download']);
    const { id } = await params;
    const download = await withRequestTenant(() => getDownloadUrl(id));
    if (request.headers.get('accept')?.includes('application/json')) {
      return Response.json({ url: download.url });
    }
    return Response.redirect(download.url, 302);
  } catch (error) {
    return toErrorResponse(error);
  }
}
