import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { completePublicFileUpload } from '@/domains/forms';
import { clientIpForLimits } from '@/lib/http/client-ip';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';
import { REQUEST_LIMITS, enforcePair } from '@/lib/http/request-limits';
import { isAuthorizationError } from '@/lib/permissions/errors';

/**
 * POST /api/public/forms/[token]/files/[evidenceId]/complete
 *
 * Marks the upload quarantined and enqueues the malware scan. The evidence id
 * must belong to this invitation. A missing or short object stays pending and
 * maps to `EVIDENCE_UPLOAD_INCOMPLETE` (409) centrally.
 */

export const dynamic = 'force-dynamic';

export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; evidenceId: string }> },
): Promise<Response> {
  const { token, evidenceId } = await params;
  const ip = clientIpForLimits(request.headers);
  const limited = await enforcePair(REQUEST_LIMITS.publicFormFile, ip, token);
  if (limited) return limited;

  try {
    await completePublicFileUpload(token, evidenceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isAuthorizationError(error)) {
      throw new ClientSafeError(
        400,
        'VALIDATION_ERROR',
        'This file could not be accepted.',
      );
    }
    throw error;
  }
});
