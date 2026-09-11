import { ClientRegister } from '@/components/teams/client-register';
import { listClients } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function ClientsPage() {
  try {
    const clients = await withRequestTenant(() => listClients());
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <ClientRegister initial={clients} />
      </div>
    );
  } catch {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        Sign in and select your organisation to view clients.
      </p>
    );
  }
}
