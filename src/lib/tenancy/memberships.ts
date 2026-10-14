import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { memberships } from '@/db/schema/membership';
import { organisations } from '@/db/schema/tenancy';
import type { ServerSession } from '@/lib/auth/session';
import {
  isOrganisationOperational,
  OPERATIONAL_ORGANISATION_STATUSES,
  UNAVAILABLE_ORGANISATION_STATUSES,
} from './organisation-status';

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
 * client input. Only active memberships of an operational organisation are
 * returned, so a suspended or revoked membership, and a suspended or closed
 * organisation, never appear as a selectable option.
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
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, 'active'),
        inArray(organisations.status, [...OPERATIONAL_ORGANISATION_STATUSES]),
      ),
    )
    .orderBy(asc(organisations.legalName));

  return rows.map((row) => ({
    organisationId: row.organisationId,
    organisationName: row.tradingName ?? row.legalName,
    slug: row.slug,
    status: row.status,
  }));
}

export type OrganisationAccess = 'operational' | 'unavailable' | 'none';

/**
 * Classify the caller's active membership of one organisation.
 *
 * `none` covers a missing or inactive membership and does not reveal whether
 * the organisation exists. `unavailable` is only returned to someone who still
 * has an active membership, so the staff shell can show a generic message.
 */
export async function organisationAccessForUser(
  userId: string,
  organisationId: string,
): Promise<OrganisationAccess> {
  const rows = await db
    .select({ status: organisations.status })
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
  const status = rows[0]?.status;
  if (!status) return 'none';
  return isOrganisationOperational(status) ? 'operational' : 'unavailable';
}

/**
 * True when the user has an active membership only of a suspended or closed
 * organisation. Used to choose the unavailable message over "no organisations".
 */
export async function hasUnavailableOrganisationMembership(
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(organisations, eq(memberships.organisationId, organisations.id))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, 'active'),
        inArray(organisations.status, [...UNAVAILABLE_ORGANISATION_STATUSES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
