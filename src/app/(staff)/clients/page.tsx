import { ClientRegister } from '@/components/teams/client-register';
import { listClients } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function ClientsPage() {
  let clients: Awaited<ReturnType<typeof listClients>> | null = null;
  try {
    clients = await withRequestTenant(() => listClients());
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
      <ClientRegister initial={clients} />
    </div>
  );
}
