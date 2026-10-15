import { NextResponse } from 'next/server';
import { createReview, type CreateReviewInput } from '@/domains/reviews';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = (await request.json()) as CreateReviewInput;
  const review = await withRequestTenant(() => createReview(id, input));
  return NextResponse.json({ review }, { status: 201 });
});
