import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { membershipRoles, memberships, roles } from '@/db/schema/membership';
import { organisations } from '@/db/schema/tenancy';
import type { ServerSession } from '@/lib/auth/session';

/**
 * Pre-tenant reads for organisation selection.
 *
 * These run BEFORE any tenant context exists — the user is in the act of
 * choosing which organisation to act within, so there is nothing to scope to
 * yet. They therefore use the raw `db` client directly rather than the
 * tenant-aware helpers. They read only the caller's own memberships, keyed by
 * the trusted session user id, and expose no other tenant's data.
 */

/** A single active membership the user may choose to act within. */
export interface UserMembership {
  organisationId: string;
  organisationName: string;
  slug: string;
  status: string;
}

/**
 * List the organisations the given user has an ACTIVE membership of, ordered
 * by display name. `userId` must come from the verified session — never from
 * client input. Only active memberships are returned, so a suspended or revoked
 * membership never appears as a selectable option.
 */
export async function listMembershipsForUser(userId: string): Promise<UserMembership[]> {
  const rows = await db
    .select({
      organisationId: memberships.organisationId,
      // Prefer the trading name; fall back to the legal name.
      legalName: organisations.legalName,
      tradingName: organisations.tradingName,
      slug: organisations.slug,
      status: memberships.status,
    })
    .from(memberships)
    .innerJoin(organisations, eq(memberships.organisationId, organisations.id))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .orderBy(asc(organisations.legalName));

  return rows.map((row) => ({
    organisationId: row.organisationId,
    organisationName: row.tradingName ?? row.legalName,
    slug: row.slug,
    status: row.status,
  }));
}

/**
 * Role slugs on the caller's active membership. `userId` comes from the
 * session. Used to choose the applicant portal or the staff shell before any
 * staff navigation is rendered.
 */
export async function listRoleSlugsForUserOrganisation(
  userId: string,
  organisationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ slug: roles.slug })
    .from(memberships)
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organisationId, organisationId),
        eq(memberships.status, 'active'),
      ),
    );
  return rows.map((row) => row.slug);
}

/**
 * Read the session's advisory active organisation id, defensively. Better Auth
 * types the session loosely for custom fields, so we narrow it here rather than
 * asserting a shape elsewhere. Returns `null` when nothing is selected.
 */
export function getActiveOrganisationId(session: ServerSession): string | null {
  const value = (session.session as { activeOrganisationId?: string | null })
    .activeOrganisationId;
  return value ?? null;
}
