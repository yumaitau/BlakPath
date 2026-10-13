import {
  MemberManagement,
  type MembershipInvitationView,
  type MemberView,
  type RoleView,
} from '@/components/tenancy/member-management';
import {
  listAssignableRoles,
  listManagedMembers,
  listMembershipInvitations,
} from '@/domains/memberships';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function PeopleSettingsPage() {
  let members: MemberView[] = [];
  let roles: RoleView[] = [];
  let invitations: MembershipInvitationView[] = [];
  let denied = false;
  try {
    [members, roles, invitations] = await withRequestTenant(async () =>
      Promise.all([
        listManagedMembers(),
        listAssignableRoles(),
        listMembershipInvitations(),
      ]),
    );
  } catch {
    denied = true;
  }
  if (denied)
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        Only organisation administrators can manage staff access.
      </p>
    );
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MemberManagement members={members} roles={roles} invitations={invitations} />
    </div>
  );
}
