/**
 * Public application directory.
 *
 * An organisation appears, and can receive a public start, only when it has
 * opted in (`publicApplicationsOpen`) and is active. The list is alphabetical.
 * It is not a ranking, a recommendation, or a judgement about who should apply
 * where. BlakPath does not determine Aboriginality.
 */

export interface PublicOrganisationSource {
  readonly id: string;
  readonly legalName: string;
  readonly tradingName: string | null;
  readonly organisationType: string | null;
  readonly slug: string;
  readonly status: string;
  readonly publicApplicationsOpen: boolean;
}

/** What the public directory is allowed to show. No internal tenancy fields. */
export interface PublicOrganisationEntry {
  readonly id: string;
  readonly name: string;
  readonly organisationType: string | null;
  readonly slug: string;
}

export function isPubliclyAcceptingApplications(org: {
  readonly status: string;
  readonly publicApplicationsOpen: boolean;
}): boolean {
  return org.status === 'active' && org.publicApplicationsOpen === true;
}

function displayName(org: PublicOrganisationSource): string {
  const trading = org.tradingName?.trim();
  return trading ? trading : org.legalName;
}

/** Opted-in organisations only, sorted by the name a person would read. */
export function toPublicDirectory(
  orgs: readonly PublicOrganisationSource[],
): PublicOrganisationEntry[] {
  return orgs
    .filter(isPubliclyAcceptingApplications)
    .map((org) => ({
      id: org.id,
      name: displayName(org),
      organisationType: org.organisationType,
      slug: org.slug,
    }))
    .sort(
      (a, b) => a.name.localeCompare(b.name, 'en-AU') || a.slug.localeCompare(b.slug),
    );
}
