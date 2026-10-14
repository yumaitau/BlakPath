import type { Metadata } from 'next';
import {
  WebhooksPanel,
  type WebhookEndpointItem,
} from '@/components/staff-tools/webhooks-panel';
import {
  StaffToolFrame,
  ToolUnavailable,
} from '@/components/staff-tools/staff-tool-frame';
import { listDeliveries, listEndpoints } from '@/domains/webhooks';
import { stringList } from '@/lib/staff/json-list';
import { loadToolPage } from '@/lib/staff/load-tool-page';

export const metadata: Metadata = { title: 'Webhooks — BlakPath' };

const description =
  'Tell another system when human work moves forward. Notices carry record ids, not personal stories. The signing secret, shown once when an endpoint is added, lets the receiver check that a notice came from BlakPath.';

export default async function WebhooksPage() {
  const loaded = await loadToolPage('/settings/webhooks', async () => {
    const endpoints = await listEndpoints();
    const items: WebhookEndpointItem[] = await Promise.all(
      endpoints.map(async (endpoint) => {
        const deliveries = await listDeliveries(endpoint.id);
        return {
          id: endpoint.id,
          url: endpoint.url,
          events: stringList(endpoint.events),
          active: endpoint.active,
          deliveries: deliveries.slice(0, 8).map((delivery) => ({
            id: delivery.id,
            event: delivery.event,
            status: delivery.status,
            attempts: delivery.attempts,
            createdAt: delivery.createdAt.toISOString(),
          })),
        };
      }),
    );
    return items;
  });

  return (
    <StaffToolFrame title="Webhooks" description={description}>
      {loaded.kind === 'ready' ? (
        <WebhooksPanel items={loaded.data} />
      ) : (
        <ToolUnavailable kind={loaded.kind} />
      )}
    </StaffToolFrame>
  );
}
