import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { FormTokenError, savePublicDraft } from '@/domains/forms';
import { isAuthorizationError } from '@/lib/permissions/errors';

/**
 * POST /api/public/forms/[token]/draft — save a partial response.
 *
 * Same token capability as submit. Answers are stored on the invitation and
 * restored by GET of the public form until the invitation expires. The token
 * stays usable for the real submission.
 */

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  let answers: unknown;
  try {
    const body = (await request.json()) as { answers?: unknown };
    answers = body.answers;
  } catch {
    return NextResponse.json({ error: 'Some answers are invalid.' }, { status: 400 });
  }

  try {
    const saved = await savePublicDraft(token, answers);
    return NextResponse.json(saved);
  } catch (error) {
    if (error instanceof FormTokenError) {
      return NextResponse.json(
        { error: 'This form link is invalid or has expired.' },
        { status: 404 },
      );
    }
    if (isAuthorizationError(error)) {
      return NextResponse.json({ error: 'Some answers are invalid.' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
