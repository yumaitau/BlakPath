import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
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
import { handlePageError } from '@/lib/http/page-errors';
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
  } catch (error) {
    await handlePageError(error);
    denied = true;
  }
  if (denied)
    return (
      <ForbiddenNotice title="You do not have access to staff settings">
        <p>Only organisation administrators can manage staff access.</p>
      </ForbiddenNotice>
    );
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MemberManagement members={members} roles={roles} invitations={invitations} />
    </div>
  );
}
