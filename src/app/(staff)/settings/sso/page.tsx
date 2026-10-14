import type { Metadata } from 'next';
import { SsoPanel, type SsoProviderItem } from '@/components/staff-tools/sso-panel';
import {
  StaffToolFrame,
  ToolUnavailable,
} from '@/components/staff-tools/staff-tool-frame';
import { listSsoBindings } from '@/domains/sso';
import { loadToolPage } from '@/lib/staff/load-tool-page';

export const metadata: Metadata = { title: 'Single sign-on — BlakPath' };

const description =
  'Connect your organisation’s sign-in for a verified email domain. This only controls how people sign in. It does not decide who is Aboriginal or Torres Strait Islander.';

export default async function SsoPage() {
  const loaded = await loadToolPage('/settings/sso', async () => {
    const rows = await listSsoBindings();
    const items: SsoProviderItem[] = rows.map((row) => ({
      id: row.id,
      providerKey: row.providerKey,
      issuer: row.issuer,
      clientId: row.clientId,
      domain: row.domain,
      enabled: row.enabled,
    }));
    return items;
  });

  return (
    <StaffToolFrame title="Single sign-on" description={description}>
      {loaded.kind === 'ready' ? (
        <SsoPanel items={loaded.data} />
      ) : (
        <ToolUnavailable kind={loaded.kind} />
      )}
    </StaffToolFrame>
  );
}
