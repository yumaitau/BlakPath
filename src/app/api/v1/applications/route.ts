import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withApiKey } from '@/lib/http/api-route';
import {
  listApplications,
  listApplicationsSchema,
  type ListApplicationsInput,
} from '@/domains/applications';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET /api/v1/applications — list applications the API key may read.
 *
 * The key's scoped permissions decide what it sees: a key without an
 * application-read scope receives an empty list (fail-closed), never an error
 * that reveals data exists.
 */
export const dynamic = 'force-dynamic';

export const GET = tenantHandler(async function GET(
  request: NextRequest,
): Promise<Response> {
  const { searchParams } = new URL(request.url);
  // Parsed before the key check so `?limit=abc` is a 400, not a 500 after auth.
  const query = listApplicationsSchema.parse({
    ...(searchParams.get('status') ? { status: searchParams.get('status') } : {}),
    ...(searchParams.get('assigneeUserId')
      ? { assigneeUserId: searchParams.get('assigneeUserId') }
      : {}),
    ...(searchParams.get('q') ? { q: searchParams.get('q') } : {}),
    ...(searchParams.get('cursor') ? { cursor: searchParams.get('cursor') } : {}),
    ...(searchParams.get('limit') ? { limit: searchParams.get('limit') } : {}),
    ...(searchParams.get('offset') ? { offset: searchParams.get('offset') } : {}),
  }) as ListApplicationsInput;
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
});
