import { NextResponse } from 'next/server';
import { addReviewComment, addReviewCommentSchema } from '@/domains/reviews';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/** POST /api/reviews/[id]/comments — add a comment to a draft review. */
export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = addReviewCommentSchema.parse(await request.json().catch(() => null));
  const row = await withRequestTenant(() => addReviewComment(id, input));
  return NextResponse.json({
    comment: {
      id: row.id,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    },
  });
});
