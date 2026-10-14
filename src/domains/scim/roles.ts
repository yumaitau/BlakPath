import { isSystemRoleSlug, type SystemRoleSlug } from '@/lib/permissions/roles';
import type { ScimUserInput } from './schemas';

/**
 * Roles an IdP may assign. `organisation-admin` is excluded unless the
 * credential was created with an explicit tenant opt-in.
 *
 * Group display names must already match the role slug (`case-officer`).
 * Unmapped names are ignored so an IdP cannot invent a permission.
 */
const BASE_SCIM_ROLES: readonly SystemRoleSlug[] = [
  'intake-officer',
  'case-officer',
  'genealogy-officer',
  'committee-member',
  'records-officer',
];

export function scimControllableRoles(
  allowOrganisationAdmin: boolean,
): readonly SystemRoleSlug[] {
  return allowOrganisationAdmin
    ? [...BASE_SCIM_ROLES, 'organisation-admin']
    : BASE_SCIM_ROLES;
}

function normaliseGroupName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z-]/g, '');
}

/** Map IdP groups and entitlements onto the controllable role allow-list. */
export function mapGroupsToRoles(
  input: ScimUserInput,
  allowOrganisationAdmin: boolean,
): SystemRoleSlug[] {
  const allowed = new Set(scimControllableRoles(allowOrganisationAdmin));
  const names = [
    ...(input.groups ?? []).map((group) => group.display),
    ...(input.entitlements ?? []).map((entitlement) => entitlement.value),
  ].map(normaliseGroupName);
  const slugs = names.filter(
    (name): name is SystemRoleSlug => isSystemRoleSlug(name) && allowed.has(name),
  );
  return [...new Set(slugs)];
}

/** Roles to add and remove so the stored set matches the IdP set. */
export function diffRoleIds(
  currentRoleIds: readonly string[],
  desiredRoleIds: readonly string[],
): { add: string[]; remove: string[] } {
  const current = new Set(currentRoleIds);
  const desired = new Set(desiredRoleIds);
  return {
    add: [...desired].filter((id) => !current.has(id)),
    remove: [...current].filter((id) => !desired.has(id)),
  };
}
