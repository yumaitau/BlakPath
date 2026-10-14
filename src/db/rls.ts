import { assertAuditRoleName, DEFAULT_AUDIT_APP_ROLE } from './audit-guard';

/**
 * Row-level security context.
 *
 * Every tenant table has the policy `tenant_isolation`, which calls
 * `blakpath_rls_allows(organisation_id)` (migration 0043). The function reads
 * two transaction-local settings:
 *
 * - `app.org_id`: the organisation a tenant transaction may see and write.
 * - `app.bypass_rls`: `on` only for the vetted platform handle
 *   (`src/db/platform-db.ts`), e.g. membership resolution before a tenant is
 *   chosen, or a sweep across organisations.
 *
 * Both are set with `set_config(..., true)` (SET LOCAL) inside a transaction,
 * so a pooled connection cannot carry them into the next request.
 */
export const TENANT_GUC = 'app.org_id';
export const BYPASS_GUC = 'app.bypass_rls';

/** SQL function every `tenant_isolation` policy calls. */
export const RLS_FUNCTION = 'blakpath_rls_allows';

export type RlsContext =
  | { readonly kind: 'tenant'; readonly organisationId: string }
  | { readonly kind: 'platform' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantContext(organisationId: string): RlsContext {
  if (!UUID.test(organisationId)) {
    throw new Error('A tenant database context needs an organisation uuid.');
  }
  return { kind: 'tenant', organisationId };
}

export const PLATFORM_CONTEXT: RlsContext = { kind: 'platform' };

export function sameRlsContext(a: RlsContext, b: RlsContext): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'platform' || a.organisationId === (b as typeof a).organisationId;
}

/**
 * Role every bound transaction runs as. Production already connects as this
 * role, so the switch is a no-op there. Local and CI connect as a superuser,
 * which bypasses RLS; switching makes tests see what production sees.
 */
export function rlsAppRole(): string {
  return assertAuditRoleName(process.env.AUDIT_DB_APP_ROLE || DEFAULT_AUDIT_APP_ROLE);
}

export interface RlsSettings {
  role: string;
  organisationId: string;
  bypass: 'on' | 'off';
}

export function rlsSettings(context: RlsContext): RlsSettings {
  return {
    role: rlsAppRole(),
    organisationId: context.kind === 'tenant' ? context.organisationId : '',
    bypass: context.kind === 'platform' ? 'on' : 'off',
  };
}

/** Parameterised SET LOCAL for role, organisation and bypass, in one round trip. */
export const APPLY_RLS_SQL = `select set_config('role', $1, true), set_config('${TENANT_GUC}', $2, true), set_config('${BYPASS_GUC}', $3, true)`;

export interface RlsExecutor {
  unsafe(query: string, parameters: string[]): PromiseLike<unknown>;
}

export async function applyRlsContext(
  executor: RlsExecutor,
  context: RlsContext,
): Promise<void> {
  const settings = rlsSettings(context);
  await executor.unsafe(APPLY_RLS_SQL, [
    settings.role,
    settings.organisationId,
    settings.bypass,
  ]);
}
