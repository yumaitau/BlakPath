import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { submitPublicResponse } from '@/domains/forms';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';
import { isAuthorizationError } from '@/lib/permissions/errors';

/**
 * POST /api/public/forms/[token] — submit a form response, unauthenticated.
 *
 * SECURITY: this endpoint has NO session. The token in the path is the entire
 * capability — `submitPublicResponse` resolves it by hash, enforces that it is
 * unexpired/unused/unrevoked, validates the answers against that form's own
 * field definitions, and writes the response under the invitation's own
 * organisation. So we call the service directly and never wrap it in
 * `withRequestTenant`. Failures are mapped to generic messages that do not
 * reveal whether a token existed.
 *
 * The request body is `{ answers: {...} }` (the renderer posts this shape).
 */

// Token-specific and side-effecting; never cached.
export const dynamic = 'force-dynamic';

export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  // First value of x-forwarded-for is the originating client (best-effort only).
  const forwardedFor = request.headers.get('x-forwarded-for');
  const ipAddress = forwardedFor?.split(',')[0]?.trim() || undefined;

  try {
    const body = (await request.json()) as { answers?: unknown };
    await submitPublicResponse(token, body.answers, ipAddress);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // Malformed JSON and answer-policy failures share one message so the
    // response does not reveal whether the token was usable.
    if (error instanceof SyntaxError || isAuthorizationError(error)) {
      throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Some answers are invalid.');
    }
    throw error;
  }
});
