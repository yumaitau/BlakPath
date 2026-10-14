import { NextResponse } from 'next/server';
import { addReviewComment, addReviewCommentSchema } from '@/domains/reviews';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** POST /api/reviews/[id]/comments — add a comment to a draft review. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
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
  } catch (error) {
    return toErrorResponse(error);
  }
}
