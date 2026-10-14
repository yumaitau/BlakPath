import type { Permission } from './catalog';
import { SYSTEM_ROLE_SLUGS, permissionsForRole, type SystemRoleSlug } from './roles';

/**
 * Route-level authorisation matrix.
 *
 * The catalogue (`catalog.ts`) is the source of truth for permission keys.
 * This table is the source of truth for which HTTP handler is gated by which
 * keys, and for the role fixtures the integration test signs in as. Adding a
 * route file or a catalogue key without updating this module fails CI.
 *
 * `allowProbe` is set only where an empty tenant can return 2xx. Routes that
 * load an object by id collapse a missing row and a forbidden read into the
 * same 403, so those rows are deny-only. No probe scores, ranks, predicts, or
 * decides Aboriginality — the software never does that.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Gate =
  | { readonly kind: 'any'; readonly permissions: readonly Permission[] }
  | { readonly kind: 'platform-operator' }
  | { readonly kind: 'member' }
  | { readonly kind: 'session' }
  | { readonly kind: 'public' }
  | { readonly kind: 'webhook-secret' }
  | { readonly kind: 'api-key' }
  | { readonly kind: 'scim' }
  | { readonly kind: 'bearer-token' }
  | { readonly kind: 'verification-code' }
  | { readonly kind: 'auth' };

/** Who the integration test authenticates as for the deny probe. */
export type DenyActor =
  | { readonly type: 'role'; readonly slug: SystemRoleSlug }
  | { readonly type: 'revoked' }
  | { readonly type: 'anonymous' }
  | { readonly type: 'uncredentialed' };

export interface RouteMatrixEntry {
  readonly method: HttpMethod;
  readonly path: string;
  readonly gate: Gate;
  /** System role expected to receive 2xx. Omitted for public probes. */
  readonly allowRole?: SystemRoleSlug;
  /** When true, the integration test asserts a 2xx for `allowRole`. */
  readonly allowProbe?: boolean;
  readonly body?: unknown;
  /** Query string without the leading `?`. May contain `{{org}}` or `{{user}}`. */
  readonly search?: string;
  /** Raw non-JSON body, sent as `text/calendar`. Wins over `body`. */
  readonly rawBody?: string;
  /** Request URL when it differs from the App Router path (Better Auth). */
  readonly requestPath?: string;
  readonly denyStatuses?: readonly number[];
  readonly denyActor?: DenyActor;
  /**
   * Present in the matrix (so a new file fails CI) but not invoked.
   * Used for dependency probes that can block on Redis or object storage.
   */
  readonly skipProbe?: boolean;
}

const FAKE_ID = '00000000-0000-4000-8000-000000000099';

const APPLICATION_PATCH = [
  'application:update-intake',
  'application:assign',
  'application:read-any',
  'application:read-assigned',
  'application:create',
  'application:read-own',
  'evidence:request',
  'evidence:upload-own',
  'review:finalise',
  'meeting:agenda-manage',
  'decision:finalise',
  'retention:manage',
] as const satisfies readonly Permission[];

/** requestUpload and completeUpload: the applicant's own upload, or staff recording a received file. */
const EVIDENCE_UPLOAD = [
  'evidence:upload-own',
  'evidence:upload-on-behalf',
] as const satisfies readonly Permission[];

const APPLICATION_READ = [
  'application:read-any',
  'application:read-assigned',
  'application:read-own',
] as const satisfies readonly Permission[];

const FAMILY_LINK = [
  'family-link:request',
  'family-link:approve',
] as const satisfies readonly Permission[];

const CONSENT_WRITE = [
  'application:create',
  'application:update-intake',
  'application:assign',
] as const satisfies readonly Permission[];

const CONSENT_READ = [
  ...CONSENT_WRITE,
  'application:read-any',
  'application:read-assigned',
] as const satisfies readonly Permission[];

const REPRESENTATIVE_LIST = [
  'application:update-intake',
  'application:assign',
] as const satisfies readonly Permission[];

const TASK_READ = [
  'application:read-assigned',
  'application:read-any',
] as const satisfies readonly Permission[];

const TASK_WRITE = [
  'application:read-any',
  'application:assign',
] as const satisfies readonly Permission[];

const FORM_MANAGE = [
  'application:read-any',
  'application:update-intake',
] as const satisfies readonly Permission[];

const TEAM_READ = [
  'team:manage',
  'membership:manage',
] as const satisfies readonly Permission[];

const CLIENT_READ = [
  'client:read-any',
  'client:read-assigned',
] as const satisfies readonly Permission[];

const CALENDAR_READ = [
  'calendar:read-any',
  'meeting:pack-access',
] as const satisfies readonly Permission[];

const MEETING_READ = [
  'meeting:pack-access',
  'meeting:create',
  'meeting:agenda-manage',
] as const satisfies readonly Permission[];

const DASHBOARD_READ = [
  'report:view',
  'application:read-any',
] as const satisfies readonly Permission[];

const CORRESPONDENCE_CASE_READ = [
  'correspondence:send',
  'application:read-any',
  'application:read-assigned',
] as const satisfies readonly Permission[];

const CORRESPONDENCE_TEMPLATE_READ = [
  'correspondence:manage-templates',
  'correspondence:send',
] as const satisfies readonly Permission[];

const CERTIFICATE_READ = [
  'certificate:generate',
  'certificate:sign',
  'certificate:revoke',
  'application:read-any',
] as const satisfies readonly Permission[];

const REPORT_READ = [
  'report:view',
  'report:export',
] as const satisfies readonly Permission[];

const DECISION_PATCH = [
  'decision:vote',
  'decision:finalise',
] as const satisfies readonly Permission[];

const ATTENDEE_PATCH = [
  'calendar:update-any',
  'calendar:read-any',
  'meeting:pack-access',
] as const satisfies readonly Permission[];

function anyOf(permissions: readonly Permission[]): Gate {
  return { kind: 'any', permissions };
}

interface Probe {
  readonly allowRole?: SystemRoleSlug;
  readonly allowProbe?: boolean;
  readonly body?: unknown;
  readonly search?: string;
  readonly rawBody?: string;
  readonly requestPath?: string;
  readonly denyStatuses?: readonly number[];
  readonly denyActor?: DenyActor;
  readonly skipProbe?: boolean;
}

function route(
  method: HttpMethod,
  path: string,
  gate: Gate,
  probe?: Probe,
): RouteMatrixEntry {
  return probe ? { method, path, gate, ...probe } : { method, path, gate };
}

const KMS_KEY_ARN = `arn:aws:kms:ap-southeast-2:111122223333:key/${FAKE_ID}`;
const MEMBER_EMAIL = { email: 'deny@example.test', roleId: FAKE_ID };
const CALENDAR_BODY = {
  title: 'Matrix event',
  startAt: '2026-10-14T01:00:00.000Z',
  endAt: '2026-10-14T02:00:00.000Z',
};

/**
 * Every exported HTTP handler under `src/app/api`.
 * Gate unions mirror the domain checks the handler can reach.
 */
export const ROUTE_MATRIX: readonly RouteMatrixEntry[] = [
  route(
    'POST',
    '/api/admin/email-suppressions',
    { kind: 'platform-operator' },
    {
      body: { address: 'deny@example.test' },
    },
  ),
  route(
    'POST',
    '/api/admin/organisations/[id]/status',
    { kind: 'platform-operator' },
    { body: { status: 'suspended' } },
  ),
  route(
    'GET',
    '/api/applications',
    { kind: 'member' },
    {
      allowRole: 'applicant',
      allowProbe: true,
    },
  ),
  route('POST', '/api/applications', anyOf(['application:create']), {
    allowRole: 'applicant',
    allowProbe: true,
    body: { applicantName: 'Matrix Applicant' },
  }),
  route('PATCH', '/api/applications/[id]', anyOf(APPLICATION_PATCH), {
    body: { operation: 'assign_self' },
  }),
  route('GET', '/api/applications/[id]/correspondence', anyOf(CORRESPONDENCE_CASE_READ)),
  route('POST', '/api/applications/[id]/correspondence', anyOf(['correspondence:send'])),
  // Step-up first (a fresh fixture session passes), then the send permission.
  route(
    'POST',
    '/api/applications/[id]/correspondence/[correspondenceId]/send',
    anyOf(['correspondence:send']),
  ),
  route('POST', '/api/applications/[id]/decisions', anyOf(['decision:propose'])),
  route('POST', '/api/applications/[id]/evidence', anyOf(EVIDENCE_UPLOAD)),
  route('POST', '/api/applications/[id]/evidence-requests', anyOf(['evidence:request'])),
  route(
    'POST',
    '/api/applications/[id]/evidence-requests/[requestId]/notify',
    anyOf(['correspondence:send']),
  ),
  // Genealogy reads also need a staff case read, so an applicant holding
  // `family-link:request` is still refused the list.
  route('GET', '/api/applications/[id]/family-links', anyOf(FAMILY_LINK), {
    denyActor: { type: 'role', slug: 'applicant' },
  }),
  route('POST', '/api/applications/[id]/family-links', anyOf(['family-link:request']), {
    body: { relationship: 'grandmother', relativeName: 'Matrix Relative' },
  }),
  route('PATCH', '/api/applications/[id]/family-links/[linkId]', anyOf(FAMILY_LINK), {
    body: { operation: 'approve' },
  }),
  route('POST', '/api/applications/[id]/reviews', anyOf(['review:create'])),
  // Gated in the audit domain (`src/domains/audit/log.ts`); a refusal is
  // itself recorded on the tenant chain.
  route('GET', '/api/audit/events', anyOf(['audit:view']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('GET', '/api/audit/events/export', anyOf(['audit:view']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/audit/reviews', anyOf(['audit:view']), {
    body: { period: '2026-10', outcome: 'no_findings' },
  }),
  route('GET', '/api/auth/[...all]', { kind: 'auth' }, { skipProbe: true }),
  route(
    'POST',
    '/api/auth/[...all]',
    { kind: 'auth' },
    {
      requestPath: '/api/auth/sign-in/email',
      body: {},
      denyStatuses: [400, 401, 403, 422],
    },
  ),
  route('GET', '/api/break-glass', anyOf(['break-glass:approve']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/break-glass', { kind: 'platform-operator' }),
  route('POST', '/api/break-glass/[id]/activate', { kind: 'platform-operator' }),
  route('POST', '/api/break-glass/[id]/approve', anyOf(['break-glass:approve'])),
  route('POST', '/api/break-glass/[id]/deny', anyOf(['break-glass:approve'])),
  route('POST', '/api/break-glass/[id]/revoke', anyOf(['break-glass:approve'])),
  route('PATCH', '/api/calendar/attendees/[id]', anyOf(ATTENDEE_PATCH), {
    body: { responseStatus: 'accepted' },
  }),
  route('GET', '/api/calendar/events', anyOf(CALENDAR_READ), {
    allowRole: 'intake-officer',
    allowProbe: true,
  }),
  route('POST', '/api/calendar/events', anyOf(['calendar:create']), {
    allowRole: 'intake-officer',
    allowProbe: true,
    body: CALENDAR_BODY,
  }),
  route('PATCH', '/api/calendar/events/[id]', anyOf(['calendar:update-any'])),
  route('DELETE', '/api/calendar/events/[id]', anyOf(['calendar:delete-any'])),
  route('POST', '/api/calendar/events/[id]/attendees', anyOf(['calendar:update-any'])),
  route('POST', '/api/calendar/events/[id]/invite', anyOf(['calendar:update-any'])),
  route('POST', '/api/calendar/import', anyOf(['meeting:create']), {
    body: { ics: 'BEGIN:VCALENDAR' },
  }),
  route('GET', '/api/calendar/meetings', anyOf(MEETING_READ), {
    allowRole: 'committee-chair',
    allowProbe: true,
  }),
  route('GET', '/api/certificates', anyOf(APPLICATION_READ), {
    search: `applicationId=${FAKE_ID}`,
  }),
  route('POST', '/api/certificates', anyOf(['certificate:generate'])),
  route('GET', '/api/certificates/[id]/download', anyOf(CERTIFICATE_READ)),
  route('POST', '/api/certificates/[id]/revoke', anyOf(['certificate:revoke'])),
  route('POST', '/api/certificates/[id]/sign', anyOf(['certificate:sign'])),
  route('GET', '/api/correspondence/[id]/letter', anyOf(CORRESPONDENCE_CASE_READ)),
  route('GET', '/api/correspondence/templates', anyOf(CORRESPONDENCE_TEMPLATE_READ), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route(
    'POST',
    '/api/correspondence/templates',
    anyOf(['correspondence:manage-templates']),
  ),
  route(
    'PATCH',
    '/api/correspondence/templates/[id]',
    anyOf(['correspondence:manage-templates']),
  ),
  route(
    'POST',
    '/api/correspondence/templates/seed',
    anyOf(['correspondence:manage-templates']),
  ),
  route('GET', '/api/clients', anyOf(CLIENT_READ), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/clients', anyOf(['client:create']), {
    allowRole: 'intake-officer',
    allowProbe: true,
    body: { displayName: 'Matrix Client' },
  }),
  route('GET', '/api/consents', anyOf(CONSENT_READ), {
    allowRole: 'applicant',
    allowProbe: true,
    search: 'subject={{user}}',
  }),
  // Public browser report sink. No credential exists; the probe checks that a
  // non-report media type is refused.
  route(
    'POST',
    '/api/csp-report',
    { kind: 'public' },
    {
      rawBody: 'not-a-report',
      denyActor: { type: 'anonymous' },
      denyStatuses: [415],
    },
  ),
  route('POST', '/api/consents', anyOf(CONSENT_WRITE), {
    allowRole: 'applicant',
    allowProbe: true,
    body: { subjectUserId: '{{user}}', purpose: 'matrix-consent' },
  }),
  route('DELETE', '/api/consents/[id]', anyOf(CONSENT_WRITE)),
  route(
    'GET',
    '/api/dashboard/layout',
    { kind: 'member' },
    {
      allowRole: 'applicant',
      allowProbe: true,
    },
  ),
  route(
    'PUT',
    '/api/dashboard/layout',
    { kind: 'member' },
    {
      allowRole: 'applicant',
      allowProbe: true,
      body: { order: ['pipeline'] },
    },
  ),
  route('GET', '/api/dashboard/stats', anyOf(DASHBOARD_READ), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('PATCH', '/api/decisions/[id]', anyOf(DECISION_PATCH), {
    body: { operation: 'withdraw_vote' },
  }),
  route('POST', '/api/email/events', { kind: 'webhook-secret' }),
  route('GET', '/api/evidence/[id]/download', anyOf(['evidence:download'])),
  route('POST', '/api/evidence/[id]/complete', anyOf(EVIDENCE_UPLOAD)),
  route('POST', '/api/evidence/[id]/classification', anyOf(['evidence:classify']), {
    body: { classification: 'Matrix label' },
  }),
  route('GET', '/api/forms', anyOf(FORM_MANAGE), {
    allowRole: 'intake-officer',
    allowProbe: true,
  }),
  route('POST', '/api/forms', anyOf(FORM_MANAGE), {
    allowRole: 'intake-officer',
    allowProbe: true,
    body: { title: 'Matrix form' },
  }),
  route('GET', '/api/forms/[id]', anyOf(FORM_MANAGE)),
  route('PATCH', '/api/forms/[id]', anyOf(FORM_MANAGE)),
  route('GET', '/api/forms/[id]/invitations', anyOf(FORM_MANAGE)),
  route('POST', '/api/forms/[id]/invitations', anyOf(FORM_MANAGE)),
  // Create-a-case also needs `application:create`; attach also needs read of
  // the target case. Both are checked in the service after this gate.
  route('POST', '/api/forms/[id]/responses/[responseId]/case', anyOf(FORM_MANAGE), {
    body: {},
  }),
  route('POST', '/api/forms/[id]/status', anyOf(FORM_MANAGE), {
    body: { status: 'published' },
  }),
  route('DELETE', '/api/forms/invitations/[invitationId]', anyOf(FORM_MANAGE)),
  route('GET', '/api/groups', anyOf(TEAM_READ), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/groups', anyOf(['group:create']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
    body: { slug: 'matrix-group', name: 'Matrix group' },
  }),
  route('GET', '/api/health', { kind: 'public' }, { skipProbe: true }),
  route('POST', '/api/imports/applications', anyOf(['application:create'])),
  route('GET', '/api/keys', anyOf(['tenant:configure']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/keys', anyOf(['tenant:configure'])),
  route('DELETE', '/api/keys/[id]', anyOf(['tenant:configure'])),
  route('GET', '/api/live', { kind: 'public' }, { allowProbe: true }),
  // GET is closed: it always answers 404 whatever the caller holds.
  route(
    'GET',
    '/api/mcp',
    { kind: 'public' },
    {
      denyActor: { type: 'anonymous' },
      denyStatuses: [404],
    },
  ),
  // 404 while the platform AI flag is off; otherwise a request with no key is 401.
  route(
    'POST',
    '/api/mcp',
    { kind: 'api-key' },
    {
      body: {},
      denyStatuses: [401, 404],
    },
  ),
  route('GET', '/api/membership-invitations', anyOf(['membership:manage']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/membership-invitations', anyOf(['membership:manage']), {
    body: MEMBER_EMAIL,
  }),
  route('DELETE', '/api/membership-invitations/[id]', anyOf(['membership:manage'])),
  route('POST', '/api/membership-invitations/[id]/resend', anyOf(['membership:manage'])),
  route(
    'POST',
    '/api/membership-invitations/accept',
    { kind: 'bearer-token' },
    {
      body: { token: 'x'.repeat(20) },
      denyStatuses: [401],
    },
  ),
  route(
    'POST',
    '/api/membership-invitations/create-account',
    { kind: 'bearer-token' },
    {
      body: {
        token: 'x'.repeat(20),
        name: 'Matrix Invitee',
        password: 'password-password',
      },
      denyStatuses: [403],
    },
  ),
  route('GET', '/api/memberships', anyOf(['membership:manage']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/memberships', anyOf(['membership:manage']), { body: MEMBER_EMAIL }),
  route('PATCH', '/api/memberships/[id]', anyOf(['membership:manage']), {
    body: { status: 'suspended' },
  }),
  route(
    'GET',
    '/api/notifications',
    { kind: 'member' },
    {
      allowRole: 'applicant',
      allowProbe: true,
    },
  ),
  route(
    'PATCH',
    '/api/notifications',
    { kind: 'member' },
    {
      allowRole: 'applicant',
      allowProbe: true,
      body: { all: true },
    },
  ),
  route('POST', '/api/organisation/activation', anyOf(['tenant:configure'])),
  route('POST', '/api/organisation-key/health-check', anyOf(['tenant:configure'])),
  route('GET', '/api/organisation-keys', anyOf(['tenant:configure']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/organisation-keys', anyOf(['tenant:configure']), {
    body: { kmsKeyArn: KMS_KEY_ARN, custodyMode: 'client_owned' },
  }),
  route(
    'GET',
    '/api/organisations',
    { kind: 'session' },
    {
      allowRole: 'applicant',
      allowProbe: true,
    },
  ),
  route(
    'POST',
    '/api/organisations/active',
    { kind: 'member' },
    {
      allowRole: 'applicant',
      allowProbe: true,
      body: { organisationId: '{{org}}' },
    },
  ),
  route('GET', '/api/organisations/session-policy', anyOf(['tenant:configure']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('PATCH', '/api/organisations/session-policy', anyOf(['tenant:configure']), {
    body: { idleTimeoutMinutes: 45 },
  }),
  route(
    'GET',
    '/api/public/correspondence/[token]/certificate',
    { kind: 'bearer-token' },
    { denyStatuses: [404] },
  ),
  route(
    'POST',
    '/api/public/forms/[token]',
    { kind: 'bearer-token' },
    {
      body: { answers: {} },
      denyStatuses: [404],
    },
  ),
  route(
    'POST',
    '/api/public/forms/[token]/draft',
    { kind: 'bearer-token' },
    {
      body: { answers: {} },
      denyStatuses: [404],
    },
  ),
  route(
    'POST',
    '/api/public/forms/[token]/files',
    { kind: 'bearer-token' },
    {
      body: {
        fieldKey: 'matrix_file',
        fileName: 'matrix.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
      },
      denyStatuses: [404],
    },
  ),
  route(
    'POST',
    '/api/public/forms/[token]/files/[evidenceId]/complete',
    { kind: 'bearer-token' },
    { denyStatuses: [404] },
  ),
  route(
    'POST',
    '/api/public/verify/[code]',
    { kind: 'verification-code' },
    { denyStatuses: [400, 404] },
  ),
  route('GET', '/api/ready', { kind: 'public' }, { skipProbe: true }),
  route('GET', '/api/reports/exports', anyOf(REPORT_READ), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/reports/exports', anyOf(['report:export'])),
  route('GET', '/api/reports/exports/[id]/download', anyOf(['report:export'])),
  route('GET', '/api/representatives', anyOf(REPRESENTATIVE_LIST), {
    allowRole: 'intake-officer',
    allowProbe: true,
  }),
  route('POST', '/api/representatives', anyOf(CONSENT_WRITE)),
  route('PATCH', '/api/representatives/[id]', anyOf(CONSENT_WRITE), {
    body: { operation: 'revoke' },
  }),
  route('GET', '/api/retention/holds', anyOf(['retention:manage']), {
    allowRole: 'records-officer',
    allowProbe: true,
  }),
  route('GET', '/api/retention/destruction-register', anyOf(['retention:manage']), {
    allowRole: 'records-officer',
    allowProbe: true,
  }),
  route('GET', '/api/retention/disposal-authorities', anyOf(['retention:manage']), {
    allowRole: 'records-officer',
    allowProbe: true,
  }),
  route('POST', '/api/retention/disposal-authorities', anyOf(['retention:manage']), {
    allowRole: 'records-officer',
    allowProbe: true,
    body: {
      jurisdiction: 'organisation',
      disposalClass: 'operational_record',
      authorityReference: 'Matrix schedule 1',
      permanent: false,
    },
  }),
  route('GET', '/api/retention/disposal-classes', anyOf(['retention:manage']), {
    allowRole: 'records-officer',
    allowProbe: true,
  }),
  route('POST', '/api/retention/holds', anyOf(['retention:manage'])),
  route('DELETE', '/api/retention/holds/[id]', anyOf(['retention:manage'])),
  route('GET', '/api/retention/policies', anyOf(['retention:manage']), {
    allowRole: 'records-officer',
    allowProbe: true,
  }),
  route('POST', '/api/retention/policies', anyOf(['retention:manage']), {
    allowRole: 'records-officer',
    allowProbe: true,
    body: {
      resourceType: 'application',
      retentionDays: 30,
      action: 'anonymise',
      jurisdiction: 'organisation',
    },
  }),
  route('DELETE', '/api/retention/policies/[id]', anyOf(['retention:manage'])),
  route('POST', '/api/retention/policies/[id]/activate', anyOf(['retention:manage'])),
  route('GET', '/api/retention/preview', anyOf(['retention:manage']), {
    allowRole: 'records-officer',
    allowProbe: true,
  }),
  route('PATCH', '/api/reviews/[id]', anyOf(['review:finalise']), {
    body: { operation: 'finalise' },
  }),
  route('POST', '/api/reviews/[id]/comments', anyOf(['review:create']), {
    body: { body: 'Matrix comment' },
  }),
  route('GET', '/api/scim/credentials', anyOf(['tenant:configure']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/scim/credentials', anyOf(['tenant:configure'])),
  route('DELETE', '/api/scim/credentials/[id]', anyOf(['tenant:configure'])),
  route('POST', '/api/scim/credentials/[id]/rotate', anyOf(['tenant:configure'])),
  route('POST', '/api/scim/v2/[orgId]/Users', { kind: 'scim' }),
  route('PATCH', '/api/scim/v2/[orgId]/Users', { kind: 'scim' }),
  route('DELETE', '/api/scim/v2/[orgId]/Users', { kind: 'scim' }),
  route('POST', '/api/session/step-up/complete', { kind: 'session' }),
  route(
    'POST',
    '/api/session/step-up/prepare',
    { kind: 'session' },
    {
      allowRole: 'applicant',
      allowProbe: true,
    },
  ),
  route('GET', '/api/settings/ai-features', anyOf(['tenant:configure']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/settings/ai-features', anyOf(['tenant:configure'])),
  route('GET', '/api/sso/providers', anyOf(['tenant:configure']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/sso/providers', anyOf(['tenant:configure'])),
  route('PATCH', '/api/sso/providers/[id]', anyOf(['tenant:configure']), {
    body: { enabled: false },
  }),
  route('GET', '/api/tasks', anyOf(TASK_READ), {
    allowRole: 'intake-officer',
    allowProbe: true,
  }),
  route('POST', '/api/tasks', anyOf(TASK_WRITE), {
    allowRole: 'intake-officer',
    allowProbe: true,
    body: { title: 'Matrix task' },
  }),
  route('PATCH', '/api/tasks/[id]', anyOf(TASK_WRITE)),
  route('DELETE', '/api/tasks/[id]', anyOf(TASK_WRITE)),
  route('POST', '/api/tasks/[id]/move', anyOf(TASK_WRITE)),
  route('GET', '/api/teams', anyOf(TEAM_READ), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/teams', anyOf(['team:create']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
    body: { slug: 'matrix-team', name: 'Matrix team' },
  }),
  route('GET', '/api/v1/applications', { kind: 'api-key' }),
  route('GET', '/api/v1/applications/[id]', { kind: 'api-key' }),
  route('GET', '/api/webhooks', anyOf(['tenant:configure']), {
    allowRole: 'organisation-admin',
    allowProbe: true,
  }),
  route('POST', '/api/webhooks', anyOf(['tenant:configure'])),
  route('DELETE', '/api/webhooks/[id]', anyOf(['tenant:configure'])),
  route('GET', '/api/webhooks/[id]/deliveries', anyOf(['tenant:configure'])),
  route(
    'POST',
    '/api/webhooks/[id]/deliveries/[deliveryId]/redeliver',
    anyOf(['tenant:configure']),
  ),
  route('POST', '/api/webhooks/[id]/rotate', anyOf(['tenant:configure'])),
];

/**
 * Catalogue keys with no HTTP `requirePermission` / `requireAny` gate.
 * They stay granted on role templates for domain services that are not routed.
 */
export const UNROUTED_PERMISSIONS = {
  'evidence:read-assigned':
    'Included in the break-glass read bundle. Download checks evidence:download.',
  'conflict:declare': 'declareConflict has no route.',
  'break-glass:request':
    'The platform-operator template grants it. Request and activate check users.isPlatformOperator, not this key.',
  'group:manage':
    'addGroupMember has no route. Group list uses team:manage or membership:manage; create uses group:create.',
  'client:assign-team': 'assignClient has no route.',
  'mcp:read':
    'API-key scope. POST /api/mcp authenticates the key, then hasMcpScope checks the key permissions. No session route checks it.',
  'mcp:read-pii':
    'API-key scope. MCP tools omit direct identifiers unless the key holds it. No session route checks it.',
} as const satisfies Partial<Record<Permission, string>>;

export type UnroutedPermission = keyof typeof UNROUTED_PERMISSIONS;

/**
 * One session fixture per system role. A new slug fails typecheck until a
 * fixture is added. Only the platform operator is flagged in the database.
 */
export const ROLE_SESSION_FIXTURES = {
  applicant: { isPlatformOperator: false },
  'applicant-representative': { isPlatformOperator: false },
  'intake-officer': { isPlatformOperator: false },
  'case-officer': { isPlatformOperator: false },
  'genealogy-officer': { isPlatformOperator: false },
  'elder-cultural-authority': { isPlatformOperator: false },
  'committee-member': { isPlatformOperator: false },
  'committee-chair': { isPlatformOperator: false },
  'records-officer': { isPlatformOperator: false },
  'organisation-admin': { isPlatformOperator: false },
  'platform-operator': { isPlatformOperator: true },
} as const satisfies Record<SystemRoleSlug, { readonly isPlatformOperator: boolean }>;

export function routeKey(entry: Pick<RouteMatrixEntry, 'method' | 'path'>): string {
  return `${entry.method} ${entry.path}`;
}

/** App Router file for a matrix path (`/api/teams` → `src/app/api/teams/route.ts`). */
export function routeFile(path: string): string {
  return `src/app${path}/route.ts`;
}

export function roleSatisfies(slug: SystemRoleSlug, gate: Gate): boolean {
  switch (gate.kind) {
    case 'any':
      return gate.permissions.some((key) => permissionsForRole(slug).includes(key));
    case 'platform-operator':
      return slug === 'platform-operator';
    case 'member':
    case 'session':
    case 'public':
      return true;
    default:
      return false;
  }
}

export function denyActorFor(entry: RouteMatrixEntry): DenyActor | null {
  if (entry.denyActor) return entry.denyActor;
  switch (entry.gate.kind) {
    case 'public':
      return null;
    case 'any': {
      const slug = SYSTEM_ROLE_SLUGS.find(
        (candidate) => !roleSatisfies(candidate, entry.gate),
      );
      return slug ? { type: 'role', slug } : { type: 'revoked' };
    }
    case 'platform-operator':
      return { type: 'role', slug: 'applicant' };
    case 'member':
      return { type: 'revoked' };
    case 'session':
    case 'auth':
      return { type: 'anonymous' };
    default:
      return { type: 'uncredentialed' };
  }
}

export function denyStatusesFor(entry: RouteMatrixEntry): readonly number[] {
  if (entry.denyStatuses) return entry.denyStatuses;
  switch (entry.gate.kind) {
    case 'api-key':
      return [401];
    case 'session':
      return [401];
    case 'webhook-secret':
      return [403, 503];
    case 'public':
      return [];
    default:
      return [403];
  }
}

export function isMutating(entry: Pick<RouteMatrixEntry, 'method'>): boolean {
  return entry.method !== 'GET';
}

export function accessLabel(entry: RouteMatrixEntry): string {
  switch (entry.gate.kind) {
    case 'any':
      return entry.gate.permissions.map((key) => `\`${key}\``).join(' or ');
    case 'platform-operator':
      return 'platform operator flag (`users.isPlatformOperator`)';
    case 'member':
      return 'active organisation membership';
    case 'session':
      return 'signed-in session';
    case 'public':
      return 'public';
    case 'webhook-secret':
      return 'email webhook secret';
    case 'api-key':
      return 'API key';
    case 'scim':
      return 'SCIM bearer token';
    case 'bearer-token':
      return 'invitation or form token';
    case 'verification-code':
      return 'certificate verification code (public capability)';
    case 'auth':
      return 'Better Auth';
    default: {
      const _exhaustive: never = entry.gate;
      return _exhaustive;
    }
  }
}

export function denyActorLabel(actor: DenyActor | null): string {
  if (!actor) return '—';
  switch (actor.type) {
    case 'role':
      return actor.slug;
    case 'revoked':
      return 'revoked membership';
    case 'anonymous':
      return 'anonymous';
    case 'uncredentialed':
      return 'no credential';
    default: {
      const _exhaustive: never = actor;
      return _exhaustive;
    }
  }
}
