import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { ClientRegister } from '@/components/teams/client-register';
import { listClients } from '@/domains/teams';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function ClientsPage() {
  let clients: Awaited<ReturnType<typeof listClients>> | null = null;
  try {
    clients = await withRequestTenant(() => listClients());
  } catch (error) {
    await handlePageError(error);
    clients = null;
  }
  if (!clients) {
    return <ForbiddenNotice title="You do not have access to clients" />;
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <ClientRegister initial={clients} />
    </div>
  );
}
