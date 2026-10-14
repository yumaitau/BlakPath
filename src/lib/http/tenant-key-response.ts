import { NextResponse } from 'next/server';
import {
  TENANT_KEY_UNAVAILABLE_MESSAGE,
  TenantKeyUnavailableError,
} from '@/lib/encryption/errors';

/**
 * Calm lock response. 423 when the key was disabled or is pending deletion.
 * 503 when KMS cannot be used. Never 500, and the body is not plaintext.
 */
export function tenantKeyErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof TenantKeyUnavailableError)) return null;
  return NextResponse.json(
    { error: TENANT_KEY_UNAVAILABLE_MESSAGE, code: error.code },
    { status: error.httpStatus },
  );
}
