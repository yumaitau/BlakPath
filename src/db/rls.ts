import { sql, type SQL } from 'drizzle-orm';

/** Non-owner role. RLS applies, including on tables the migrator owns. */
export const APP_ROLE = 'blakpath_app';

/** Vetted pre-tenant paths (token lookup, public verification, membership resolution). */
export const PLATFORM_ROLE = 'blakpath_platform';

/** Transaction-local GUC. Matches the policy in `src/db/schema/_rls.ts`. */
export const TENANT_GUC = 'app.org_id';

const ROLES = new Set<string>([APP_ROLE, PLATFORM_ROLE]);

type Executable = {
  execute: (query: SQL) => Promise<unknown>;
};

/**
 * `set_config(..., true)` is the parameterised form of SET LOCAL. The role
 * change is local to the open transaction so a pooled connection cannot leak
 * it to the next request.
 */
export async function applyRlsRole(
  tx: Executable,
  role: string,
  organisationId: string | null,
): Promise<void> {
  if (!ROLES.has(role)) {
    throw new Error(`Refusing to assume unknown database role "${role}".`);
  }
  if (role === APP_ROLE && !organisationId) {
    throw new Error('The tenant database role requires an organisation id.');
  }
  await tx.execute(sql`select set_config('role', ${role}, true)`);
  if (organisationId) {
    await tx.execute(sql`select set_config(${TENANT_GUC}, ${organisationId}, true)`);
  }
}
