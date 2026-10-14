import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  memberships,
  membershipRoles,
  organisations,
  roles,
  rolePermissions,
} from '@/db/schema';
import type { Permission } from '@/lib/permissions/catalog';
import { isPermission } from '@/lib/permissions/catalog';
import type { TenantContext } from './context';
import { TenantContextError } from './context';
import {
  isOrganisationOperational,
  OrganisationUnavailableError,
} from './organisation-status';

/**
 * The trusted tenancy boundary.
 *
 * `resolveTenantContext` is where a browser-supplied `organisationId` is turned
 * into a verified TenantContext — or rejected. It NEVER trusts the supplied org
 * id: it queries the database for an ACTIVE membership binding this user to that
 * exact organisation, and only then loads the user's roles and effective
 * permissions. If there is no active membership, it throws and no context is
 * produced, so nothing downstream can act within a tenant the user does not
 * belong to. A suspended or closed organisation is refused even when the
 * membership itself is active.
 *
 * This function is the single entry point that route handlers, server actions
 * and job runners call before doing any tenant-scoped work (usually via
 * with-tenant.ts, which wraps the result in runWithTenantContext).
 */

/** Inputs required to resolve a context. `organisationId` is UNTRUSTED input. */
export interface ResolveTenantInput {
  /** Authenticated user id (from the verified session — trusted). */
  readonly userId: string;
  /** Session id, carried through for audit attribution. */
  readonly sessionId: string;
  /** UNTRUSTED: the organisation the request claims to act within. */
  readonly organisationId: string;
  /** Correlation id for tracing this unit of work. */
  readonly correlationId: string;
  /** Per-request id for tracing/audit. */
  readonly requestId: string;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
  /** Optional active break-glass grant already verified upstream. */
  readonly breakGlass?: { requestId: string; reason: string } | undefined;
}

/**
 * Verify the user's active membership of the given organisation and build the
 * TenantContext. Throws {@link TenantContextError} when no active membership
 * exists — callers must treat a throw as "access denied for this tenant".
 * Throws {@link OrganisationUnavailableError} when the membership is active
 * but the organisation is suspended or closed.
 */
export async function resolveTenantContext(
  input: ResolveTenantInput,
): Promise<TenantContext> {
  const {
    userId,
    sessionId,
    organisationId,
    correlationId,
    requestId,
    ipAddress,
    userAgent,
    breakGlass,
  } = input;

  // 1. Verify an ACTIVE membership binding THIS user to THIS org. The org id is
  //    part of the WHERE clause, never applied after the fact — an inactive or
  //    absent membership yields no row and therefore no context.
  const membershipRow = await db
    .select({
      id: memberships.id,
      organisationStatus: organisations.status,
    })
    .from(memberships)
    .innerJoin(organisations, eq(memberships.organisationId, organisations.id))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organisationId, organisationId),
        eq(memberships.status, 'active'),
      ),
    )
    .limit(1);

  const membership = membershipRow[0];
  if (!membership) {
    // Generic, non-leaking failure: do not reveal whether the org exists.
    throw new TenantContextError('You do not have active access to this organisation.');
  }
  if (!isOrganisationOperational(membership.organisationStatus)) {
    // The caller is a member, so the refusal may say the organisation cannot
    // be used. It still must not name suspended versus closed.
    throw new OrganisationUnavailableError();
  }

  // 2. Load the roles attached to this membership.
  const roleRows = await db
    .select({ id: roles.id, slug: roles.slug })
    .from(membershipRoles)
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(eq(membershipRoles.membershipId, membership.id));

  const roleIds = roleRows.map((r) => r.id);
  const roleSlugs = roleRows.map((r) => r.slug);

  // 3. Load the effective permission set (union of all role grants). Only keys
  //    that are still in the catalogue are admitted — a stale grant to a removed
  //    permission key can never confer access.
  const permissionSet = new Set<Permission>();
  if (roleIds.length > 0) {
    const permissionRows = await db
      .select({ permissionKey: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, roleIds));

    for (const { permissionKey } of permissionRows) {
      if (isPermission(permissionKey)) {
        permissionSet.add(permissionKey);
      }
    }
  }

  return {
    organisationId,
    userId,
    membershipId: membership.id,
    permissions: permissionSet,
    roles: roleSlugs,
    sessionId,
    correlationId,
    requestId,
    ...(ipAddress !== undefined ? { ipAddress } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
    ...(breakGlass !== undefined ? { breakGlass } : {}),
  } satisfies TenantContext;
}
