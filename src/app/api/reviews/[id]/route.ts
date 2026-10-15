import { NextResponse } from 'next/server';
import { z } from 'zod';
import { finaliseReview, reopenReview } from '@/domains/reviews';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

const mutationSchema = z.object({
  operation: z.enum(['finalise', 'reopen']),
});

export const PATCH = tenantHandler(async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = mutationSchema.parse(await request.json().catch(() => null));
  const review = await withRequestTenant(() =>
    input.operation === 'finalise' ? finaliseReview(id) : reopenReview(id),
  );
  return NextResponse.json({ review });
});
