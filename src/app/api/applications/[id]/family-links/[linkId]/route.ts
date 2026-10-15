import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  approveFamilyLink,
  disputeFamilyLink,
  withdrawFamilyLink,
} from '@/domains/family-links';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

const mutationSchema = z.object({
  operation: z.enum(['approve', 'dispute', 'withdraw']),
  note: z.string().trim().max(5000).optional(),
});

/**
 * PATCH /api/applications/[id]/family-links/[linkId]
 *
 * `approve` and `dispute` need `family-link:approve` and a different person
 * from the requester. The same person is refused with 403 and the denial is
 * audited. `withdraw` is the requester, before a decision. None of these
 * operations determines Aboriginality.
 */
export const PATCH = tenantHandler(async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; linkId: string }> },
): Promise<Response> {
  const { id, linkId } = await params;
  const input = mutationSchema.parse(await request.json());
  const link = await withRequestTenant(() => {
    if (input.operation === 'approve') {
      return approveFamilyLink(id, linkId, { note: input.note });
    }
    if (input.operation === 'dispute') {
      return disputeFamilyLink(id, linkId, { note: input.note });
    }
    return withdrawFamilyLink(id, linkId);
  });
  return NextResponse.json({ link });
});
