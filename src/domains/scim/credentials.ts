import { desc, eq, isNull } from 'drizzle-orm';
import { scimCredentials } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { createScimCredentialSchema, type CreateScimCredentialInput } from './schemas';
import { generateScimToken, hashScimToken, scimDisplayPrefix } from './tokens';

/**
 * SCIM credential management — tenant-scoped, permission-checked, audited.
 *
 * Requires `tenant:configure`. The raw token is returned once on create and
 * on rotate. Rotation revokes the previous credential in the same transaction.
 */

export type ScimCredentialRow = typeof scimCredentials.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

/** Create a credential. Returns the raw token once; only the hash is stored. */
export async function createScimCredential(
  rawInput: CreateScimCredentialInput,
): Promise<{ credential: ScimCredentialRow; token: string }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const input = createScimCredentialSchema.parse(rawInput);
  const token = generateScimToken();
  const expiresAt = new Date(Date.now() + input.expiresInDays * DAY_MS);

  const scope = currentScope();
  const inserted = await scope.db
    .insert(scimCredentials)
    .values(
      scope.insertValues({
        name: input.name,
        tokenHash: hashScimToken(token),
        prefix: scimDisplayPrefix(token),
        allowOrganisationAdmin: input.allowOrganisationAdmin,
        createdByUserId: ctx.userId,
        expiresAt,
      }),
    )
    .returning();
  const credential = must(inserted[0], 'scim credential');

  await recordAudit({
    action: 'scim.credential_created',
    resourceType: 'scim_credential',
    resourceId: credential.id,
    result: 'success',
    after: {
      data: {
        prefix: credential.prefix,
        allowOrganisationAdmin: credential.allowOrganisationAdmin,
      },
      allow: ['prefix', 'allowOrganisationAdmin'],
    },
  });

  return { credential, token };
}

/** List the tenant's SCIM credentials. Never returns the hash or raw token. */
export async function listScimCredentials(): Promise<
  Array<
    Pick<
      ScimCredentialRow,
      | 'id'
      | 'name'
      | 'prefix'
      | 'allowOrganisationAdmin'
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
      id: scimCredentials.id,
      name: scimCredentials.name,
      prefix: scimCredentials.prefix,
      allowOrganisationAdmin: scimCredentials.allowOrganisationAdmin,
      lastUsedAt: scimCredentials.lastUsedAt,
      expiresAt: scimCredentials.expiresAt,
      revokedAt: scimCredentials.revokedAt,
      createdAt: scimCredentials.createdAt,
    })
    .from(scimCredentials)
    .where(scope.where(scimCredentials.organisationId))
    .orderBy(desc(scimCredentials.createdAt));
}

/** Revoke a credential immediately. */
export async function revokeScimCredential(id: string): Promise<ScimCredentialRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();
  const updated = await scope.db
    .update(scimCredentials)
    .set({ revokedAt: new Date() })
    .where(
      scope.where(
        scimCredentials.organisationId,
        eq(scimCredentials.id, id),
        isNull(scimCredentials.revokedAt),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) throw new AuthorizationError('POLICY_DENIED');

  await recordAudit({
    action: 'scim.credential_revoked',
    resourceType: 'scim_credential',
    resourceId: id,
    result: 'success',
    after: { data: { prefix: row.prefix }, allow: ['prefix'] },
  });
  return row;
}

/**
 * Revoke the named credential and issue a replacement with the same name and
 * organisation-admin opt-in. The previous token stops matching immediately.
 */
export async function rotateScimCredential(
  id: string,
): Promise<{ credential: ScimCredentialRow; token: string }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();
  const token = generateScimToken();
  const now = new Date();

  const credential = await scope.db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(scimCredentials)
      .where(
        scope.where(
          scimCredentials.organisationId,
          eq(scimCredentials.id, id),
          isNull(scimCredentials.revokedAt),
        ),
      )
      .limit(1);
    if (!existing) throw new AuthorizationError('POLICY_DENIED');

    await tx
      .update(scimCredentials)
      .set({ revokedAt: now })
      .where(eq(scimCredentials.id, existing.id));
    const inserted = await tx
      .insert(scimCredentials)
      .values(
        scope.insertValues({
          name: existing.name,
          tokenHash: hashScimToken(token),
          prefix: scimDisplayPrefix(token),
          allowOrganisationAdmin: existing.allowOrganisationAdmin,
          createdByUserId: ctx.userId,
          expiresAt: new Date(now.getTime() + 365 * DAY_MS),
        }),
      )
      .returning();
    const created = must(inserted[0], 'scim credential');
    return { created, previousId: existing.id };
  });

  await recordAudit({
    action: 'scim.credential_rotated',
    resourceType: 'scim_credential',
    resourceId: credential.created.id,
    result: 'success',
    after: {
      data: {
        previousId: credential.previousId,
        prefix: credential.created.prefix,
        allowOrganisationAdmin: credential.created.allowOrganisationAdmin,
      },
      allow: ['previousId', 'prefix', 'allowOrganisationAdmin'],
    },
  });

  return { credential: credential.created, token };
}
