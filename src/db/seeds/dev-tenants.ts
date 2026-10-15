/**
 * Stable non-production fixture identities.
 *
 * E2E imports these ids so isolation checks hit rows that actually exist in
 * the second council, not an all-zero placeholder. Production seed never
 * inserts them (`seedDevBootstrap` returns before use).
 */

export const DEV_ORGANISATION_NAME = 'BlakPath Development Organisation';

export const DEV_TENANT_B = {
  organisationId: '018f5c3a-7b2e-7a10-8c4d-b20000000001',
  slug: 'dev-org-b',
  legalName: 'BlakPath Second Council',
  adminEmail: 'admin-b@blakpath.local',
  adminPassword: 'blakpath-dev-admin-b-2026',
  applicationId: '018f5c3a-7b2e-7a10-8c4d-b20000000002',
  clientId: '018f5c3a-7b2e-7a10-8c4d-b20000000003',
  clientName: 'E2E second council client',
  applicantName: 'E2E second council applicant',
  applicationReference: 'APP-E2E-B',
} as const;

/** Org A staff used to prove team-scoped reads. Not members of tenant B. */
export const DEV_TEAM_FIXTURE = {
  teamId: '018f5c3a-7b2e-7a10-8c4d-a10000000001',
  teamSlug: 'e2e-intake',
  teamName: 'E2E Intake',
  clientId: '018f5c3a-7b2e-7a10-8c4d-a10000000002',
  clientName: 'E2E assigned client',
  applicationId: '018f5c3a-7b2e-7a10-8c4d-a10000000003',
  applicantName: 'E2E team-scoped applicant',
  applicationReference: 'APP-E2E-TEAM',
  assignedEmail: 'case-officer@blakpath.local',
  assignedPassword: 'blakpath-dev-case-officer-2026',
  unassignedEmail: 'unassigned-officer@blakpath.local',
  unassignedPassword: 'blakpath-dev-unassigned-2026',
} as const;
