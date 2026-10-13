import { runWithTenantContext, type TenantContext } from '@/lib/tenancy/context';
import { currentRequestIds } from '@/lib/observability/correlation';
import { ApiKeyError, parseBearer, resolveApiKeyContext } from '@/domains/api-keys';

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

  const bound = currentRequestIds();
  const ctx = await resolveApiKeyContext(raw, {
    correlationId: bound?.correlationId ?? globalThis.crypto.randomUUID(),
    requestId: bound?.requestId ?? globalThis.crypto.randomUUID(),
    ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  return runWithTenantContext(ctx, () => fn(ctx));
}
