import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { CollectionNoticeError } from '@/domains/consent';
import { FormTokenError, submitPublicResponse } from '@/domains/forms';
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
 * The request body is `{ answers: {...}, acknowledgement: { version, hash } }`
 * (the renderer posts this shape). The acknowledgement must name the
 * organisation's CURRENT collection notice or nothing is stored (409).
 */

// Token-specific and side-effecting; never cached.
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  let answers: unknown;
  let acknowledgement: unknown;
  try {
    const body = (await request.json()) as {
      answers?: unknown;
      acknowledgement?: unknown;
    };
    answers = body.answers;
    acknowledgement = body.acknowledgement;
  } catch {
    // Malformed JSON is treated as invalid answers rather than a server fault.
    return NextResponse.json({ error: 'Some answers are invalid.' }, { status: 400 });
  }

  // First value of x-forwarded-for is the originating client (best-effort only).
  const forwardedFor = request.headers.get('x-forwarded-for');
  const ipAddress = forwardedFor?.split(',')[0]?.trim() || undefined;

  try {
    await submitPublicResponse(token, answers, ipAddress, acknowledgement);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof FormTokenError) {
      return NextResponse.json(
        { error: 'This form link is invalid or has expired.' },
        { status: 404 },
      );
    }
    if (error instanceof CollectionNoticeError) {
      return NextResponse.json(
        { error: 'Please read and acknowledge the current collection notice.' },
        { status: 409 },
      );
    }
    if (isAuthorizationError(error)) {
      return NextResponse.json({ error: 'Some answers are invalid.' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
