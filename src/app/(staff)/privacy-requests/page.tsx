import {
  RightsRequestRegister,
  type ClientOption,
} from '@/components/privacy/rights-request-register';
import { listRequests } from '@/domains/privacy';
import { listClients } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function PrivacyRequestsPage() {
  let requests: Awaited<ReturnType<typeof listRequests>> | null = null;
  let clients: ClientOption[] = [];
  try {
    requests = await withRequestTenant(() => listRequests());
    clients = await withRequestTenant(async () =>
      (await listClients()).map((c) => ({ id: c.id, displayName: c.displayName })),
    ).catch(() => []);
  } catch {
    requests = null;
  }
  if (!requests) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        Privacy requests are handled by staff with the privacy permission.
      </p>
    );
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <RightsRequestRegister initial={requests} clients={clients} />
    </div>
  );
}
