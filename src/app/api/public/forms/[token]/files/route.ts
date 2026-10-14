import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { requestPublicFileUpload } from '@/domains/forms';
import { clientIpForLimits } from '@/lib/http/client-ip';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';
import { REQUEST_LIMITS, enforcePair } from '@/lib/http/request-limits';
import { isAuthorizationError } from '@/lib/permissions/errors';

/**
 * POST /api/public/forms/[token]/files — presign a file-field upload.
 *
 * The token is the only capability. Bytes are not accepted here; the client
 * PUTs them to the quarantine bucket with the returned URL, then calls complete
 * so the object is scanned like any other evidence.
 */

export const dynamic = 'force-dynamic';

export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const ip = clientIpForLimits(request.headers);
  const limited = await enforcePair(REQUEST_LIMITS.publicFormFile, ip, token);
  if (limited) return limited;

  try {
    const body: unknown = await request.json();
    const prepared = await requestPublicFileUpload(token, body);
    return NextResponse.json(prepared, { status: 201 });
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof ZodError ||
      isAuthorizationError(error)
    ) {
      throw new ClientSafeError(
        400,
        'VALIDATION_ERROR',
        'This file could not be accepted.',
      );
    }
    throw error;
  }
});
