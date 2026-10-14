import { runWithTenantContext, type TenantContext } from '@/lib/tenancy/context';
import { ApiKeyError, parseBearer, resolveApiKeyContext } from '@/domains/api-keys';
import { UNKNOWN_CLIENT_IP, clientIpForLimits } from '@/lib/http/client-ip';
import {
  REQUEST_LIMITS,
  assertIp,
  assertKey,
  type RequestLimitPolicy,
} from '@/lib/http/request-limits';
import { currentRequestIds } from '@/lib/observability/correlation';

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

  const bound = currentRequestIds();
  const ctx = await resolveApiKeyContext(raw, {
    correlationId: bound?.correlationId ?? globalThis.crypto.randomUUID(),
    requestId: bound?.requestId ?? globalThis.crypto.randomUUID(),
    ...(ip === UNKNOWN_CLIENT_IP ? {} : { ipAddress: ip }),
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  await assertKey(limits, ctx.userId);

  return runWithTenantContext(ctx, () => fn(ctx));
}
