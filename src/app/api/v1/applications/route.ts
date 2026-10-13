import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { apiErrorResponse, withApiKey } from '@/lib/http/api-route';
import { listApplications, type ListApplicationsInput } from '@/domains/applications';

/**
 * GET /api/v1/applications — list applications the API key may read.
 *
 * The key's scoped permissions decide what it sees: a key without an
 * application-read scope receives an empty list (fail-closed), never an error
 * that reveals data exists.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    // Raw query values; validated (and status-enum enforced) by the zod schema
    // inside listApplications, so the cast is safe.
    const query = {
      ...(searchParams.get('status') ? { status: searchParams.get('status') } : {}),
      ...(searchParams.get('assigneeUserId')
        ? { assigneeUserId: searchParams.get('assigneeUserId') }
        : {}),
      ...(searchParams.get('q') ? { q: searchParams.get('q') } : {}),
      ...(searchParams.get('cursor') ? { cursor: searchParams.get('cursor') } : {}),
      ...(searchParams.get('limit') ? { limit: searchParams.get('limit') } : {}),
      ...(searchParams.get('offset') ? { offset: searchParams.get('offset') } : {}),
    } as ListApplicationsInput;
    const result = await withApiKey(request, () => listApplications(query));
    return NextResponse.json({
      items: result.items.map((a) => ({
        id: a.id,
        reference: a.reference,
        status: a.status,
        priority: a.priority,
        createdAt: a.createdAt,
      })),
      limit: result.limit,
      offset: result.offset,
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
