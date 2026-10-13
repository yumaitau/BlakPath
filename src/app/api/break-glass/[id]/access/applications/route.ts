import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { listApplications, type ListApplicationsInput } from '@/domains/applications';
import { projectBreakGlassApplication } from '@/domains/break-glass';
import { withBreakGlassAccess } from '@/lib/http/break-glass-access';
import { breakGlassErrorResponse } from '@/lib/http/platform-route';

/**
 * GET /api/break-glass/[id]/access/applications
 * Read-only application register for a live grant. Intake JSON is omitted.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const query = request.nextUrl.searchParams;
    const input: ListApplicationsInput = {
      limit: query.get('limit') || undefined,
      offset: query.get('offset') || undefined,
    };
    const result = await withBreakGlassAccess(id, () => listApplications(input));
    return NextResponse.json({
      items: result.items.map(projectBreakGlassApplication),
      limit: result.limit,
      offset: result.offset,
    });
  } catch (error) {
    return breakGlassErrorResponse(error);
  }
}
