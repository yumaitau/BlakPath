import { TeamManagement } from '@/components/teams/team-management';
import { listGroups, listTeams } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function TeamsSettingsPage() {
  try {
    const [teams, groups] = await withRequestTenant(async () =>
      Promise.all([listTeams(), listGroups()]),
    );
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <TeamManagement initialTeams={teams} initialGroups={groups} />
      </div>
    );
  } catch {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        Only organisation administrators can manage teams.
      </p>
    );
  }
}
