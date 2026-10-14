import { NextResponse } from 'next/server';
import { runWithTenantContext, type TenantContext } from '@/lib/tenancy/context';
import { AuthorizationError } from '@/lib/permissions/errors';
import { ApiKeyError, parseBearer, resolveApiKeyContext } from '@/domains/api-keys';
import { UNKNOWN_CLIENT_IP, clientIpForLimits } from '@/lib/http/client-ip';
import {
  REQUEST_LIMITS,
  RateLimitedError,
  assertIp,
  assertKey,
  rateLimitResponse,
  type RequestLimitPolicy,
} from '@/lib/http/request-limits';
import { tenantKeyErrorResponse } from '@/lib/http/tenant-key-response';

/**
 * Route helper for the public REST API (`/api/v1/*`).
 *
 * Authenticates the request by its `Authorization: Bearer bp_...` key, resolves
 * a SCOPED tenant context (see `resolveApiKeyContext`), and runs `fn` inside it.
 * There is no session — the key is the capability. A missing/invalid key is a
 * 401; a permission failure inside `fn` is a 403; too many requests is a 429.
 * Nothing leaks which key failed.
 */
export async function withApiKey<T>(
  request: Request,
  fn: (ctx: TenantContext) => Promise<T> | T,
  limits: RequestLimitPolicy = REQUEST_LIMITS.api,
): Promise<T> {
  const ip = clientIpForLimits(request.headers);
  // Count the address before resolving the key so a bad key still spends the
  // IP budget. The key bucket is the database id, never the bearer secret.
  await assertIp(limits, ip);

  const raw = parseBearer(request.headers.get('authorization'));
  if (!raw) throw new ApiKeyError();

  const ctx = await resolveApiKeyContext(raw, {
    correlationId: globalThis.crypto.randomUUID(),
    requestId: globalThis.crypto.randomUUID(),
    ...(ip === UNKNOWN_CLIENT_IP ? {} : { ipAddress: ip }),
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  await assertKey(limits, ctx.userId);

  return runWithTenantContext(ctx, () => fn(ctx));
}

/** Map an error thrown in an API route to a non-leaking JSON response. */
export function apiErrorResponse(error: unknown): NextResponse {
  const locked = tenantKeyErrorResponse(error);
  if (locked) return locked;
  if (error instanceof RateLimitedError) return rateLimitResponse(error.retryAfter);
  if (error instanceof ApiKeyError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (error instanceof AuthorizationError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}
