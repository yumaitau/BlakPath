import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { TeamManagement } from '@/components/teams/team-management';
import { listGroups, listTeams } from '@/domains/teams';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function TeamsSettingsPage() {
  let teams: Awaited<ReturnType<typeof listTeams>> | null = null;
  let groups: Awaited<ReturnType<typeof listGroups>> | null = null;
  try {
    [teams, groups] = await withRequestTenant(async () =>
      Promise.all([listTeams(), listGroups()]),
    );
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
      <TeamManagement initialTeams={teams} initialGroups={groups} />
    </div>
  );
}
