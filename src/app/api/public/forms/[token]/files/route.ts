import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { FormTokenError, requestPublicFileUpload } from '@/domains/forms';
import { isAuthorizationError } from '@/lib/permissions/errors';

/**
 * POST /api/public/forms/[token]/files — presign a file-field upload.
 *
 * The token is the only capability. Bytes are not accepted here; the client
 * PUTs them to the quarantine bucket with the returned URL, then calls complete
 * so the object is scanned like any other evidence.
 */

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'This file could not be accepted.' },
      { status: 400 },
    );
  }

  try {
    const prepared = await requestPublicFileUpload(token, body);
    return NextResponse.json(prepared, { status: 201 });
  } catch (error) {
    if (error instanceof FormTokenError) {
      return NextResponse.json(
        { error: 'This form link is invalid or has expired.' },
        { status: 404 },
      );
    }
    if (error instanceof ZodError || isAuthorizationError(error)) {
      return NextResponse.json(
        { error: 'This file could not be accepted.' },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
