import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { savePublicDraft } from '@/domains/forms';
import { isTenantKeyUnavailable } from '@/lib/encryption/errors';
import { clientIpForLimits } from '@/lib/http/client-ip';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';
import { REQUEST_LIMITS, enforcePair } from '@/lib/http/request-limits';
import { isAuthorizationError } from '@/lib/permissions/errors';

/**
 * POST /api/public/forms/[token]/draft — save a partial response.
 *
 * Same token capability as submit, never `withRequestTenant`. Answers are
 * sealed on the invitation and restored by the public form page until the
 * invitation expires. The token stays usable for the real submission.
 * Failures do not reveal whether the token existed.
 */

export const dynamic = 'force-dynamic';

export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const ip = clientIpForLimits(request.headers);
  const limited = await enforcePair(REQUEST_LIMITS.publicFormDraft, ip, token);
  if (limited) return limited;

  // FormTokenError (404) and OrganisationUnavailableError (403) map centrally.
  try {
    const body = (await request.json()) as { answers?: unknown };
    const saved = await savePublicDraft(token, body.answers);
    return NextResponse.json(saved);
  } catch (error) {
    if (error instanceof SyntaxError || isAuthorizationError(error)) {
      throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Some answers are invalid.');
    }
    if (isTenantKeyUnavailable(error)) {
      throw new ClientSafeError(500, 'INTERNAL_ERROR', 'Internal error');
    }
    throw error;
  }
});
