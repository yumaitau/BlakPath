/**
 * The permission catalogue.
 *
 * This is the single source of truth for every permission key in BlakPath. Role
 * templates (roles.ts) grant subsets of these keys; the checker (check.ts)
 * evaluates them; the database `permissions` table is seeded from this catalogue
 * so the DB, the RBAC layer and the type system can never drift apart.
 *
 * PRODUCT INVARIANT: not one permission in this catalogue authorises the
 * software to DETERMINE Aboriginality. There is no score, rank, prediction,
 * auto-approve or auto-reject permission — and there never will be. Every key
 * here gates a HUMAN action (propose, vote, finalise, sign) or a data action
 * (read, upload, classify). Determination authority always rests with
 * authorised humans in the organisation.
 */

/** Human-facing groupings, used for admin UIs and the seed `category` column. */
export const PERMISSION_CATEGORIES = [
  'application',
  'evidence',
  'family-link',
  'review',
  'meeting',
  'calendar',
  'team',
  'group',
  'client',
  'decision',
  'certificate',
  'reporting',
  'audit',
  'retention',
  'administration',
  'break-glass',
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/** Shape of a single catalogue entry. */
export interface PermissionDefinition {
  readonly key: string;
  readonly category: PermissionCategory;
  readonly description: string;
}

/**
 * Every permission key, with its category and a plain-English description.
 *
 * Descriptions use trauma-aware, plain, respectful Australian English — they may
 * be shown to organisation administrators when configuring roles.
 */
export const PERMISSION_CATALOG = Object.freeze({
  'application:create': {
    key: 'application:create',
    category: 'application',
    description:
      'Start a new Confirmation of Aboriginality application on behalf of an applicant.',
  },
  'application:read-own': {
    key: 'application:read-own',
    category: 'application',
    description:
      'View applications that the person themselves submitted or is represented on.',
  },
  'application:read-assigned': {
    key: 'application:read-assigned',
    category: 'application',
    description: 'View applications assigned to the worker for handling.',
  },
  'application:read-any': {
    key: 'application:read-any',
    category: 'application',
    description:
      'View any application within the organisation, regardless of assignment.',
  },
  'application:update-intake': {
    key: 'application:update-intake',
    category: 'application',
    description:
      'Update intake details on an application (contact, demographic and administrative fields).',
  },
  'application:assign': {
    key: 'application:assign',
    category: 'application',
    description: 'Assign or reassign an application to a worker.',
  },
  'evidence:upload-own': {
    key: 'evidence:upload-own',
    category: 'evidence',
    description: 'Upload supporting evidence to one’s own application.',
  },
  'evidence:read-assigned': {
    key: 'evidence:read-assigned',
    category: 'evidence',
    description: 'View evidence attached to an assigned application.',
  },
  'evidence:classify': {
    key: 'evidence:classify',
    category: 'evidence',
    description: 'Record the type and handling classification of a piece of evidence.',
  },
  'evidence:download': {
    key: 'evidence:download',
    category: 'evidence',
    description: 'Download the original file of a piece of evidence.',
  },
  'evidence:request': {
    key: 'evidence:request',
    category: 'evidence',
    description: 'Request further evidence from an applicant.',
  },
  'family-link:request': {
    key: 'family-link:request',
    category: 'family-link',
    description:
      'Request that a family connection be recorded or verified for an application.',
  },
  'family-link:approve': {
    key: 'family-link:approve',
    category: 'family-link',
    description:
      'Approve a requested family connection after appropriate cultural and records checks.',
  },
  'review:create': {
    key: 'review:create',
    category: 'review',
    description:
      'Create a review of an application, recording observations for the committee.',
  },
  'review:finalise': {
    key: 'review:finalise',
    category: 'review',
    description:
      'Finalise a review so it becomes part of the record put before the committee.',
  },
  'meeting:create': {
    key: 'meeting:create',
    category: 'meeting',
    description: 'Schedule a committee meeting.',
  },
  'meeting:agenda-manage': {
    key: 'meeting:agenda-manage',
    category: 'meeting',
    description: 'Add, remove and order applications on a meeting agenda.',
  },
  'meeting:pack-access': {
    key: 'meeting:pack-access',
    category: 'meeting',
    description:
      'Access the confidential meeting pack of applications and supporting material.',
  },
  'conflict:declare': {
    key: 'conflict:declare',
    category: 'meeting',
    description:
      'Declare a conflict of interest for a specific application or meeting item.',
  },
  'decision:propose': {
    key: 'decision:propose',
    category: 'decision',
    description: 'Propose a decision on an application for the committee to consider.',
  },
  'decision:vote': {
    key: 'decision:vote',
    category: 'decision',
    description: 'Cast a vote on a proposed decision as a committee member.',
  },
  'decision:finalise': {
    key: 'decision:finalise',
    category: 'decision',
    description: 'Finalise and record the committee’s decision on an application.',
  },
  'certificate:generate': {
    key: 'certificate:generate',
    category: 'certificate',
    description:
      'Generate a draft Confirmation of Aboriginality certificate from a finalised decision.',
  },
  'certificate:sign': {
    key: 'certificate:sign',
    category: 'certificate',
    description: 'Sign a certificate, giving it authority on behalf of the organisation.',
  },
  'certificate:revoke': {
    key: 'certificate:revoke',
    category: 'certificate',
    description: 'Revoke a previously issued certificate.',
  },
  'report:view': {
    key: 'report:view',
    category: 'reporting',
    description: 'View operational and administrative reports for the organisation.',
  },
  'report:export': {
    key: 'report:export',
    category: 'reporting',
    description: 'Export report data (a sensitive action that is always audit-logged).',
  },
  'audit:view': {
    key: 'audit:view',
    category: 'audit',
    description: 'View the tamper-evident audit trail for the organisation.',
  },
  'retention:manage': {
    key: 'retention:manage',
    category: 'retention',
    description: 'Manage data-retention settings and act on retention schedules.',
  },
  'tenant:configure': {
    key: 'tenant:configure',
    category: 'administration',
    description:
      'Configure the organisation’s settings, terminology, guidance and branding.',
  },
  'membership:manage': {
    key: 'membership:manage',
    category: 'administration',
    description: 'Invite, suspend and assign roles to people in the organisation.',
  },
  'break-glass:request': {
    key: 'break-glass:request',
    category: 'break-glass',
    description:
      'Request emergency (break-glass) access for a specific, time-boxed support purpose.',
  },
  'break-glass:approve': {
    key: 'break-glass:approve',
    category: 'break-glass',
    description:
      'Approve a break-glass request (must be a different person from the requester).',
  },
  'team:create': {
    key: 'team:create',
    category: 'team',
    description: 'Create a team inside the organisation.',
  },
  'team:manage': {
    key: 'team:manage',
    category: 'team',
    description: 'Manage teams and assign staff to teams.',
  },
  'group:create': {
    key: 'group:create',
    category: 'group',
    description: 'Create a group inside the organisation.',
  },
  'group:manage': {
    key: 'group:manage',
    category: 'group',
    description: 'Manage groups and assign staff to groups.',
  },
  'client:create': {
    key: 'client:create',
    category: 'client',
    description: 'Register a new client person record for the organisation.',
  },
  'client:read-assigned': {
    key: 'client:read-assigned',
    category: 'client',
    description: 'View clients assigned to your team or group.',
  },
  'client:read-any': {
    key: 'client:read-any',
    category: 'client',
    description: 'View any client in the organisation, regardless of assignment.',
  },
  'client:assign-team': {
    key: 'client:assign-team',
    category: 'client',
    description: 'Assign or reassign a client to a team.',
  },
  'calendar:create': {
    key: 'calendar:create',
    category: 'calendar',
    description: 'Create a calendar event.',
  },
  'calendar:read-any': {
    key: 'calendar:read-any',
    category: 'calendar',
    description: 'View any calendar event in the organisation.',
  },
  'calendar:update-any': {
    key: 'calendar:update-any',
    category: 'calendar',
    description: 'Reschedule or edit any calendar event.',
  },
  'calendar:delete-any': {
    key: 'calendar:delete-any',
    category: 'calendar',
    description: 'Delete a calendar event.',
  },
} as const satisfies Record<string, PermissionDefinition>);

/** The union of every valid permission key. */
export type Permission = keyof typeof PERMISSION_CATALOG;

/** All permission keys as a readonly, frozen array (stable order). */
export const ALL_PERMISSIONS = Object.freeze(
  Object.keys(PERMISSION_CATALOG) as Permission[],
);

/** A ready-to-seed list for the `permissions` table. */
export const PERMISSION_SEED: readonly PermissionDefinition[] = Object.freeze(
  Object.values(PERMISSION_CATALOG),
);

/** Runtime guard: is an arbitrary string a known permission key? */
export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSION_CATALOG, value);
}
