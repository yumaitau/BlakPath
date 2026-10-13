import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { listBreakGlassAudit } from '@/domains/break-glass';
import { withBreakGlassAccess } from '@/lib/http/break-glass-access';
import { breakGlassErrorResponse } from '@/lib/http/platform-route';

/** GET /api/break-glass/[id]/access/audit — recent audit events, break-glass flagged. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const rawLimit = request.nextUrl.searchParams.get('limit');
    const limit = rawLimit ? Number(rawLimit) : 50;
    const items = await withBreakGlassAccess(id, () =>
      listBreakGlassAudit(Number.isFinite(limit) ? limit : 50),
    );
    return NextResponse.json({ items });
  } catch (error) {
    return breakGlassErrorResponse(error);
  }
}
