import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { organisationDomains, organisationSsoProviders } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';

/**
 * SSO binding service — tenant-scoped, permission-checked, audited.
 * Bindings route a verified email domain to a registered provider key.
 * Secrets stay in Secrets Manager; enabling requires a verified domain.
 */

export type SsoBindingRow = typeof organisationSsoProviders.$inferSelect;

const bindingSchema = z.object({
  providerKey: z.string().trim().min(1).max(100),
  issuer: z.url().max(500),
  clientId: z.string().trim().min(1).max(300),
  domain: z.string().trim().toLowerCase().max(253),
});

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} from database.`);
  return row;
}

export async function createSsoBinding(raw: z.input<typeof bindingSchema>): Promise<SsoBindingRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const input = bindingSchema.parse(raw);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(organisationSsoProviders)
    .values(
      scope.insertValues({
        providerKey: input.providerKey,
        issuer: input.issuer,
        clientId: input.clientId,
        domain: input.domain,
        enabled: false,
      }),
    )
    .returning();
  const row = must(inserted[0], 'sso binding');
  await recordAudit({
    action: 'admin.settings_updated',
    resourceType: 'organisation',
    resourceId: scope.organisationId,
    result: 'success',
    reason: `sso binding created for ${input.providerKey}`,
  });
  return row;
}

export async function listSsoBindings(): Promise<SsoBindingRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();
  return scope.db
    .select()
    .from(organisationSsoProviders)
    .where(scope.where(organisationSsoProviders.organisationId))
    .orderBy(asc(organisationSsoProviders.providerKey));
}

/** Enable only when the binding domain is verified for this tenant. */
export async function setSsoBindingEnabled(id: string, enabled: boolean): Promise<SsoBindingRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(organisationSsoProviders)
    .where(scope.where(organisationSsoProviders.organisationId, eq(organisationSsoProviders.id, id)))
    .limit(1);
  const binding = scope.assertOwned(rows[0]);
  if (!binding) throw new AuthorizationError('POLICY_DENIED');
  if (enabled) {
    const domains = await scope.db
      .select()
      .from(organisationDomains)
      .where(
        scope.where(
          organisationDomains.organisationId,
          eq(organisationDomains.domain, binding.domain),
          eq(organisationDomains.verified, true),
        ),
      )
      .limit(1);
    if (domains.length === 0) {
      throw new AuthorizationError('POLICY_DENIED');
    }
  }
  const updated = await scope.db
    .update(organisationSsoProviders)
    .set({ enabled })
    .where(scope.where(organisationSsoProviders.organisationId, eq(organisationSsoProviders.id, id)))
    .returning();
  const row = must(updated[0], 'sso binding');
  await recordAudit({
    action: 'admin.settings_updated',
    resourceType: 'organisation',
    resourceId: scope.organisationId,
    result: 'success',
    reason: `sso binding ${enabled ? 'enabled' : 'disabled'} for ${binding.providerKey}`,
  });
  return row;
}
