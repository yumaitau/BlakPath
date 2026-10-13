import { NextResponse } from 'next/server';
import { z } from 'zod';
import { castVote, finaliseDecision, withdrawVote } from '@/domains/decisions';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

const mutationSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('vote'),
    choice: z.enum(['for', 'against', 'abstain']),
    note: z.string().trim().max(2000).optional(),
  }),
  z.object({ operation: z.literal('withdraw_vote') }),
  z.object({
    operation: z.literal('finalise'),
    outcome: z.enum(['confirmed', 'not_confirmed', 'deferred']),
    note: z.string().trim().max(5000).optional(),
    meetingId: z.uuid().optional(),
  }),
]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const input = mutationSchema.parse(await request.json().catch(() => null));
    const result = await withRequestTenant(async () => {
      if (input.operation === 'vote') {
        return castVote(id, { choice: input.choice, note: input.note });
      }
      if (input.operation === 'withdraw_vote') {
        await withdrawVote(id);
        return null;
      }
      return finaliseDecision(id, {
        outcome: input.outcome,
        note: input.note,
        meetingId: input.meetingId,
      });
    });
    return NextResponse.json({ result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
