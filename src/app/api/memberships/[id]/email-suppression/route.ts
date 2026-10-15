import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { clearEmailSuppression } from '@/domains/memberships';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * DELETE — clear the bounce/complaint email suppression on this membership's
 * address so BlakPath resumes sending to it. Organisation administrators only;
 * audited as `email.suppression_cleared`.
 */
export const DELETE = tenantHandler(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(
    STEP_UP_ROUTES['DELETE /api/memberships/[id]/email-suppression'],
  );
  const id = z.uuid().parse((await params).id);
  const cleared = await withRequestTenant(() =>
    clearEmailSuppression({ kind: 'membership', id }),
  );
  return NextResponse.json({ cleared });
});
