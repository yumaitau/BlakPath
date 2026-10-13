import { NextResponse } from 'next/server';
import { runWithTenantContext, type TenantContext } from '@/lib/tenancy/context';
import { AuthorizationError } from '@/lib/permissions/errors';
import { ApiKeyError, parseBearer, resolveApiKeyContext } from '@/domains/api-keys';
import { OrganisationUnavailableError } from '@/lib/tenancy/organisation-status';

/**
 * Route helper for the public REST API (`/api/v1/*`).
 *
 * Authenticates the request by its `Authorization: Bearer bp_...` key, resolves
 * a SCOPED tenant context (see `resolveApiKeyContext`), and runs `fn` inside it.
 * There is no session — the key is the capability. A missing/invalid key is a
 * 401; a permission failure inside `fn` is a 403; nothing leaks which.
 */
export async function withApiKey<T>(
  request: Request,
  fn: (ctx: TenantContext) => Promise<T> | T,
): Promise<T> {
  const raw = parseBearer(request.headers.get('authorization'));
  if (!raw) throw new ApiKeyError();

  const ctx = await resolveApiKeyContext(raw, {
    correlationId: globalThis.crypto.randomUUID(),
    requestId: globalThis.crypto.randomUUID(),
    ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  return runWithTenantContext(ctx, () => fn(ctx));
}

/** Map an error thrown in an API route to a non-leaking JSON response. */
export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiKeyError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (
    error instanceof AuthorizationError ||
    error instanceof OrganisationUnavailableError
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}
