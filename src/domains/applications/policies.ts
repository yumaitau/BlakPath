import {
  hasPermission,
  requiring,
  some,
  type Policy,
  type Subject,
} from '@/lib/permissions/check';

/**
 * Contextual read policies for applications.
 *
 * Capability checks answer "can this role read applications at all?"; these
 * policies answer "may this subject read THIS application?". They are pure
 * predicates (see check.ts) so they compose and test trivially, and they fail
 * closed — an application no policy admits is not readable.
 *
 * Three independent grounds may admit a read, matched to the catalogue:
 *   - `application:read-any`      — any application in the tenant.
 *   - `application:read-assigned` — one currently assigned to the actor.
 *   - `application:read-own`      — one the actor is the applicant on.
 *   - team ground                 — one whose owning client sits in the actor's
 *     team (`application:read-assigned` + team membership of the matter).
 */

/** The minimum an application must expose for a read decision. */
export interface ApplicationReadResource {
  /** The applicant's user id, when linked. */
  readonly applicantUserId: string | null;
  /** User ids with an ACTIVE assignment on the application. */
  readonly assigneeUserIds: ReadonlySet<string> | readonly string[];
  /** User ids in the team owning the matter's client (empty when unassigned). */
  readonly teamMemberUserIds?: ReadonlySet<string> | readonly string[];
}

function isAssignedTo(resource: ApplicationReadResource, userId: string): boolean {
  const ids = resource.assigneeUserIds;
  const set = ids instanceof Set ? ids : new Set(ids);
  return set.has(userId);
}

/** Actor holds read-any: every application in the tenant is readable. */
export const canReadAnyApplication: Policy<ApplicationReadResource> = requiring(
  'application:read-any',
  () => true,
);

/** Actor holds read-assigned AND is an active assignee of this application. */
export const canReadAssignedApplication: Policy<ApplicationReadResource> = requiring(
  'application:read-assigned',
  (subject, resource) => isAssignedTo(resource, subject.userId),
);

/** Actor holds read-own AND is the applicant on this application. */
export const canReadOwnApplication: Policy<ApplicationReadResource> = requiring(
  'application:read-own',
  (subject, resource) => resource.applicantUserId === subject.userId,
);

/** Actor holds read-assigned AND sits in the team owning the matter's client. */
export const canReadTeamApplication: Policy<ApplicationReadResource> = requiring(
  'application:read-assigned',
  (subject, resource) => {
    const ids = resource.teamMemberUserIds ?? [];
    const set = ids instanceof Set ? ids : new Set(ids);
    return set.has(subject.userId);
  },
);

/** The composed read policy: any single ground is sufficient. */
export const canReadApplication: Policy<ApplicationReadResource> = some(
  canReadAnyApplication,
  canReadAssignedApplication,
  canReadOwnApplication,
  canReadTeamApplication,
);

/**
 * Convenience boolean form used by the service and list filters when it just
 * needs a yes/no without throwing.
 */
export function subjectCanReadApplication(
  subject: Subject,
  resource: ApplicationReadResource,
): boolean {
  return canReadApplication(subject, resource);
}

/**
 * Does the subject read applications organisation-wide (read-any)? Used by the
 * list path to decide between an unfiltered tenant listing and a listing
 * narrowed to the actor's own/assigned applications.
 */
export function readsAllApplications(subject: Subject): boolean {
  return hasPermission(subject, 'application:read-any');
}
