import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { TeamManagement } from '@/components/teams/team-management';
import {
  listActiveStaff,
  listGroupMembers,
  listGroups,
  listTeamMembers,
  listTeams,
  type GroupMemberView,
  type StaffOption,
  type TeamMemberView,
} from '@/domains/teams';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function TeamsSettingsPage() {
  let teams: Awaited<ReturnType<typeof listTeams>> | null = null;
  let groups: Awaited<ReturnType<typeof listGroups>> | null = null;
  let teamMembers: TeamMemberView[] = [];
  let groupMembers: GroupMemberView[] = [];
  let staff: StaffOption[] = [];
  try {
    const loaded = await withRequestTenant(async () => {
      const [teamRows, groupRows, teamMemberRows, groupMemberRows, staffRows] =
        await Promise.all([
          listTeams(),
          listGroups(),
          listTeamMembers(),
          listGroupMembers(),
          listActiveStaff(),
        ]);
      return { teamRows, groupRows, teamMemberRows, groupMemberRows, staffRows };
    });
    teams = loaded.teamRows;
    groups = loaded.groupRows;
    teamMembers = loaded.teamMemberRows;
    groupMembers = loaded.groupMemberRows;
    staff = loaded.staffRows;
  } catch (error) {
    await handlePageError(error);
    teams = null;
    groups = null;
  }
  if (!teams || !groups) {
    return (
      <ForbiddenNotice title="You do not have access to team settings">
        <p>Only organisation administrators can manage teams.</p>
      </ForbiddenNotice>
    );
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <TeamManagement
        initialTeams={teams}
        initialGroups={groups}
        teamMembers={teamMembers}
        groupMembers={groupMembers}
        staff={staff}
      />
    </div>
  );
}
