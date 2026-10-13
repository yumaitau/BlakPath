import { eq } from 'drizzle-orm';
import { platformDb as db } from '@/db/platform-db';
import { apiKeys } from '@/db/schema';
import { isPermission, type Permission } from '@/lib/permissions/catalog';
import type { TenantContext } from '@/lib/tenancy/context';
import { hashApiKey } from './keys';

/**
 * The API-key trust boundary.
 *
 * `resolveApiKeyContext` turns a raw bearer key into a verified, SCOPED
 * TenantContext — or rejects it. There is no session and no membership lookup:
 * the key IS the capability. It is matched by hash (never trusting the raw
 * value), checked for revocation/expiry, and yields a context whose permission
 * set is exactly the key's granted scopes (intersected with the live catalogue,
 * so a scope removed from the catalogue can never confer access).
 *
 * The synthetic principal is the KEY itself: `userId`/`membershipId`/`sessionId`
 * all carry the key id, and the acting role is `api-key`, so every audited action
 * attributes cleanly to the credential that performed it.
 */

/** Generic, non-leaking failure for any bad/revoked/expired key. */
export class ApiKeyError extends Error {
  readonly code = 'API_KEY_INVALID';
  readonly status = 401;
  constructor() {
    super('The API key is missing, invalid, revoked or expired.');
    this.name = 'ApiKeyError';
  }
}

export interface ApiKeyContextInput {
  readonly correlationId: string;
  readonly requestId: string;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

export async function resolveApiKeyContext(
  rawKey: string,
  input: ApiKeyContextInput,
): Promise<TenantContext> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(rawKey)))
    .limit(1);
  const key = rows[0];
  if (!key) throw new ApiKeyError();
  if (key.revokedAt) throw new ApiKeyError();
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) throw new ApiKeyError();

  // Record last use (best-effort; a failure here must not deny a valid request).
  try {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id));
  } catch {
    // ignore
  }

  const permissions = new Set<Permission>();
  const scopeList = Array.isArray(key.scopes) ? (key.scopes as unknown[]) : [];
  for (const scope of scopeList) {
    if (typeof scope === 'string' && isPermission(scope)) permissions.add(scope);
  }

  return {
    organisationId: key.organisationId,
    userId: key.id,
    membershipId: key.id,
    permissions,
    roles: ['api-key'],
    sessionId: key.id,
    correlationId: input.correlationId,
    requestId: input.requestId,
    ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
    ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
  } satisfies TenantContext;
}
