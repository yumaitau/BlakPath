import { desc, eq, isNull } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { apiKeys } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { isPermission } from '@/lib/permissions/catalog';
import { createApiKeySchema, type CreateApiKeyInput } from './schemas';
import { API_KEY_PREFIX, displayPrefix, hashApiKey } from './keys';

/**
 * API-key management — tenant-scoped, permission-checked, audited.
 *
 * Managing keys requires `tenant:configure` (an administrative capability). A
 * key can only be granted scopes the CREATOR themselves holds, so a key never
 * escalates privilege beyond its issuer. The raw secret is returned exactly once
 * on creation; only its hash is stored.
 */

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/** Random secret body (excludes the `bp_` prefix). URL-safe alphabet. */
const secretGen = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  40,
);

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

/** Create a key. Returns the RAW secret once; only the hash is persisted. */
export async function createApiKey(
  rawInput: CreateApiKeyInput,
): Promise<{ apiKey: ApiKeyRow; key: string }> {
  const ctx = requireTenantContext();
  const subject = subjectFromContext(ctx);
  requirePermission(subject, 'tenant:configure');

  const input = createApiKeySchema.parse(rawInput);

  // Privilege ceiling: a key may only carry scopes its creator holds.
  for (const scope of input.scopes) {
    if (!subject.permissions.has(scope)) {
      throw new AuthorizationError(
        'POLICY_DENIED',
        'You cannot grant a key a permission you do not hold.',
      );
    }
  }

  const raw = `${API_KEY_PREFIX}${secretGen()}`;
  const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const scope = currentScope();
  const inserted = await scope.db
    .insert(apiKeys)
    .values(
      scope.insertValues({
        name: input.name,
        keyHash: hashApiKey(raw),
        prefix: displayPrefix(raw),
        scopes: input.scopes,
        createdByUserId: ctx.userId,
        expiresAt,
      }),
    )
    .returning();
  const apiKey = must(inserted[0], 'api key');

  await recordAudit({
    action: 'api_key.created',
    resourceType: 'api_key',
    resourceId: apiKey.id,
    result: 'success',
    after: {
      data: { prefix: apiKey.prefix },
      allow: ['prefix'],
    },
  });

  return { apiKey, key: raw };
}

/** List the tenant's API keys (never the hash or raw secret). */
export async function listApiKeys(): Promise<
  Array<
    Pick<
      ApiKeyRow,
      | 'id'
      | 'name'
      | 'prefix'
      | 'scopes'
      | 'lastUsedAt'
      | 'expiresAt'
      | 'revokedAt'
      | 'createdAt'
    >
  >
> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');

  const scope = currentScope();
  return scope.db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(scope.where(apiKeys.organisationId))
    .orderBy(desc(apiKeys.createdAt));
}

/** Revoke a key immediately. */
export async function revokeApiKey(id: string): Promise<ApiKeyRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');

  const scope = currentScope();
  const updated = await scope.db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      scope.where(apiKeys.organisationId, eq(apiKeys.id, id), isNull(apiKeys.revokedAt)),
    )
    .returning();
  const row = must(updated[0], 'api key');

  await recordAudit({
    action: 'api_key.revoked',
    resourceType: 'api_key',
    resourceId: id,
    result: 'success',
  });
  return row;
}

/** Re-export the permission-key guard for callers building scope pickers. */
export { isPermission };
