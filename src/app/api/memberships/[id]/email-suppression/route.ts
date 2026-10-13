import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { clearEmailSuppression } from '@/domains/memberships';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * DELETE — clear the bounce/complaint email suppression on this membership's
 * address so BlakPath resumes sending to it. Organisation administrators only;
 * audited as `email.suppression_cleared`.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.privileged);
    const id = z.uuid().parse((await params).id);
    const cleared = await withRequestTenant(() =>
      clearEmailSuppression({ kind: 'membership', id }),
    );
    return NextResponse.json({ cleared });
  } catch (error) {
    return toErrorResponse(error);
  }
}
