import { NextResponse } from 'next/server';

import { completePublicFileUpload, FormTokenError } from '@/domains/forms';
import { isAuthorizationError } from '@/lib/permissions/errors';

/**
 * POST /api/public/forms/[token]/files/[evidenceId]/complete
 *
 * Marks the upload quarantined and enqueues the malware scan. The evidence id
 * must belong to this invitation.
 */

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string; evidenceId: string }> },
): Promise<Response> {
  const { token, evidenceId } = await params;

  try {
    await completePublicFileUpload(token, evidenceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof FormTokenError) {
      return NextResponse.json(
        { error: 'This form link is invalid or has expired.' },
        { status: 404 },
      );
    }
    if (isAuthorizationError(error)) {
      return NextResponse.json(
        { error: 'This file could not be accepted.' },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
