import { ClientRegister } from '@/components/teams/client-register';
import { listClients, listTeamOptions } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function ClientsPage() {
  let clients: Awaited<ReturnType<typeof listClients>> | null = null;
  let teams: Array<{ id: string; name: string }> = [];
  let canAssign = false;
  try {
    const loaded = await withRequestTenant(async (ctx) => {
      const rows = await listClients();
      const mayAssign = ctx.permissions.has('client:assign-team');
      const teamRows = mayAssign ? await listTeamOptions() : [];
      return { rows, mayAssign, teamRows };
    });
    clients = loaded.rows;
    canAssign = loaded.mayAssign;
    teams = loaded.teamRows;
  } catch {
    clients = null;
  }
  if (!clients) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        Sign in and select your organisation to view clients.
      </p>
    );
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <ClientRegister initial={clients} teams={teams} canAssign={canAssign} />
    </div>
  );
}
