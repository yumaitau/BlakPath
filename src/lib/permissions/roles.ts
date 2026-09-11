import type { Permission } from './catalog';

/**
 * Default system role templates.
 *
 * These are the built-in roles seeded as system templates (roles with a null
 * `organisationId`). An organisation adopts or clones them; it never edits the
 * templates in place. Each template maps to an explicit, closed set of
 * permission keys — grants are allow-lists, never wildcards.
 *
 * SEPARATION OF DUTIES is encoded structurally here, not left to convention:
 *  - `organisation-admin` administers people and configuration but is given NO
 *    evidence:* and NO decision:* / certificate:* permissions. Running the
 *    organisation must never let one person also handle applicants’ evidence or
 *    determine outcomes.
 *  - `case-officer` prepares and reviews work but CANNOT `decision:finalise` or
 *    sign certificates — finalising and signing sit with the committee/chair.
 *  - `committee-member` gets `meeting:pack-access` and `decision:vote` but NOT
 *    `certificate:sign`; a voter is not, by that role alone, a signatory.
 *  - `committee-chair` may `decision:finalise` and `certificate:sign` but the
 *    checker still enforces per-item conflict and different-actor guards at
 *    runtime (a chair cannot finalise a decision they are conflicted on).
 *  - `platform-operator` is a break-glass support role: it holds NO tenant data
 *    permissions at all, only the ability to request emergency access, which a
 *    tenant approver must separately approve.
 *
 * PRODUCT INVARIANT: no role grants any capability to have the software
 * determine Aboriginality — because no such capability exists in the catalogue.
 */

/** The stable slugs of the built-in system roles. */
export const SYSTEM_ROLE_SLUGS = [
  'applicant',
  'applicant-representative',
  'intake-officer',
  'case-officer',
  'genealogy-officer',
  'elder-cultural-authority',
  'committee-member',
  'committee-chair',
  'records-officer',
  'organisation-admin',
  'platform-operator',
] as const;

export type SystemRoleSlug = (typeof SYSTEM_ROLE_SLUGS)[number];

/** Full definition of a system role template. */
export interface SystemRoleTemplate {
  readonly slug: SystemRoleSlug;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly Permission[];
}

/**
 * The role → permission mapping.
 *
 * Kept explicit (no spreading of one role into another) so a reviewer can read
 * exactly what each role can do and confirm the separation-of-duties boundaries
 * above by eye.
 */
export const SYSTEM_ROLES = Object.freeze({
  applicant: {
    slug: 'applicant',
    name: 'Applicant',
    description:
      'A person applying for confirmation. Can start and view their own application and upload their own evidence.',
    permissions: [
      'application:create',
      'application:read-own',
      'evidence:upload-own',
      'family-link:request',
    ],
  },

  'applicant-representative': {
    slug: 'applicant-representative',
    name: 'Applicant Representative',
    description:
      'A person authorised to act for an applicant (e.g. a parent or advocate). Access is always time-boxed and consent-backed.',
    permissions: [
      'application:create',
      'application:read-own',
      'evidence:upload-own',
      'family-link:request',
    ],
  },

  'intake-officer': {
    slug: 'intake-officer',
    name: 'Intake Officer',
    description:
      'Receives applications, records intake details and assigns work. Does not review or decide.',
    permissions: [
      'application:create',
      'application:read-any',
      'application:update-intake',
      'application:assign',
      'evidence:read-assigned',
      'evidence:request',
      'client:create',
      'client:read-any',
      'client:assign-team',
      'calendar:create',
      'calendar:read-any',
    ],
  },

  'case-officer': {
    slug: 'case-officer',
    name: 'Case Officer',
    description:
      'Prepares and reviews assigned applications for the committee. Cannot finalise decisions or sign certificates.',
    permissions: [
      'application:read-assigned',
      'application:update-intake',
      'evidence:read-assigned',
      'evidence:classify',
      'evidence:download',
      'evidence:request',
      'family-link:request',
      'review:create',
      'review:finalise',
      'client:read-assigned',
      'calendar:create',
      'calendar:read-any',
    ],
  },

  'genealogy-officer': {
    slug: 'genealogy-officer',
    name: 'Genealogy Officer',
    description:
      'Carries out family-connection and records research to support (never determine) an application.',
    permissions: [
      'application:read-assigned',
      'evidence:read-assigned',
      'evidence:classify',
      'evidence:download',
      'family-link:request',
      'family-link:approve',
      'review:create',
    ],
  },

  'elder-cultural-authority': {
    slug: 'elder-cultural-authority',
    name: 'Elder / Cultural Authority',
    description:
      'Provides cultural authority input to the committee. May access meeting packs, declare conflicts and vote.',
    permissions: [
      'application:read-assigned',
      'evidence:read-assigned',
      'family-link:approve',
      'review:create',
      'meeting:pack-access',
      'conflict:declare',
      'decision:vote',
    ],
  },

  'committee-member': {
    slug: 'committee-member',
    name: 'Committee Member',
    description:
      'Sits on the confirmation committee. Accesses the meeting pack, declares conflicts and votes. Cannot finalise or sign.',
    permissions: [
      'application:read-any',
      'meeting:pack-access',
      'conflict:declare',
      'decision:propose',
      'decision:vote',
      'calendar:read-any',
    ],
  },

  'committee-chair': {
    slug: 'committee-chair',
    name: 'Committee Chair',
    description:
      'Chairs the committee. Manages meetings and agendas, finalises decisions and signs certificates, subject to conflict guards.',
    permissions: [
      'application:read-any',
      'meeting:create',
      'meeting:agenda-manage',
      'meeting:pack-access',
      'conflict:declare',
      'decision:propose',
      'decision:vote',
      'decision:finalise',
      'certificate:generate',
      'certificate:sign',
      'certificate:revoke',
      'calendar:create',
      'calendar:read-any',
      'calendar:update-any',
    ],
  },

  'records-officer': {
    slug: 'records-officer',
    name: 'Records Officer',
    description:
      'Custodian of records. Generates certificates from finalised decisions and manages retention. Does not vote or sign.',
    permissions: [
      'application:read-any',
      'evidence:read-assigned',
      'evidence:classify',
      'evidence:download',
      'certificate:generate',
      'report:view',
      'report:export',
      'retention:manage',
      'client:read-any',
      'calendar:read-any',
    ],
  },

  'organisation-admin': {
    slug: 'organisation-admin',
    name: 'Organisation Administrator',
    description:
      'Administers people and configuration. Deliberately holds NO evidence, decision or certificate permissions (separation of duties).',
    permissions: [
      'tenant:configure',
      'membership:manage',
      'report:view',
      'audit:view',
      'break-glass:approve',
      'team:create',
      'team:manage',
      'group:create',
      'group:manage',
      'client:read-any',
      'calendar:read-any',
    ],
  },

  'platform-operator': {
    slug: 'platform-operator',
    name: 'Platform Operator',
    description:
      'Anthropic-side / provider support role. Holds NO tenant data permissions; may only request break-glass access, which a tenant must approve.',
    permissions: ['break-glass:request'],
  },
} as const satisfies Record<SystemRoleSlug, SystemRoleTemplate>);

/** All system role templates as a stable, frozen array (for seeding). */
export const SYSTEM_ROLE_SEED: readonly SystemRoleTemplate[] = Object.freeze(
  Object.values(SYSTEM_ROLES),
);

/** Resolve the permission set for a given system role slug. */
export function permissionsForRole(slug: SystemRoleSlug): readonly Permission[] {
  return SYSTEM_ROLES[slug].permissions;
}

/** Runtime guard: is an arbitrary string a known system role slug? */
export function isSystemRoleSlug(value: string): value is SystemRoleSlug {
  return Object.prototype.hasOwnProperty.call(SYSTEM_ROLES, value);
}
