import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organisations } from '@/db/schema';

/**
 * Organisation lifecycle gate.
 *
 * Membership can be active while the organisation itself is suspended or
 * closed. Those two states must refuse staff, public form tokens, API keys
 * and background jobs. `draft` and `onboarding` stay usable so a tenant can
 * be set up. The message is generic: callers must not learn whether the
 * organisation was suspended or closed.
 */

export const ORGANISATION_STATUSES = [
  'draft',
  'onboarding',
  'active',
  'suspended',
  'closed',
] as const;

export type OrganisationStatus = (typeof ORGANISATION_STATUSES)[number];

/** Statuses that may still do tenant work. */
export const OPERATIONAL_ORGANISATION_STATUSES = [
  'draft',
  'onboarding',
  'active',
] as const satisfies readonly OrganisationStatus[];

/** Statuses that must refuse every tenant entry point. */
export const UNAVAILABLE_ORGANISATION_STATUSES = [
  'suspended',
  'closed',
] as const satisfies readonly OrganisationStatus[];

const OPERATIONAL = new Set<string>(OPERATIONAL_ORGANISATION_STATUSES);

/** Shown to people. APIs still respond 403 with a generic forbidden body. */
export const ORGANISATION_UNAVAILABLE_MESSAGE = 'Organisation unavailable';

export function isOrganisationOperational(status: string | null | undefined): boolean {
  return typeof status === 'string' && OPERATIONAL.has(status);
}

/** A usable credential or membership whose organisation cannot be used. */
export class OrganisationUnavailableError extends Error {
  readonly code = 'ORGANISATION_UNAVAILABLE';
  readonly status = 403;
  constructor() {
    super(ORGANISATION_UNAVAILABLE_MESSAGE);
    this.name = 'OrganisationUnavailableError';
  }
}

/**
 * Whether background work for this organisation may run.
 *
 * Missing and unavailable organisations are skipped. A database error is
 * thrown so the job retries rather than being dropped during an outage.
 */
export async function isOrganisationAcceptingWork(
  organisationId: string,
): Promise<boolean> {
  if (!organisationId) return false;
  const rows = await db
    .select({ status: organisations.status })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  return isOrganisationOperational(rows[0]?.status);
}

/** Throw {@link OrganisationUnavailableError} unless the organisation can work. */
export async function assertOrganisationOperational(
  organisationId: string,
): Promise<void> {
  if (!(await isOrganisationAcceptingWork(organisationId))) {
    throw new OrganisationUnavailableError();
  }
}
