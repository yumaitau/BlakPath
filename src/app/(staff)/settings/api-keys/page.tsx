import type { Metadata } from 'next';
import {
  ApiKeysPanel,
  type ApiKeyListItem,
  type ApiKeyScopeOption,
} from '@/components/staff-tools/api-keys-panel';
import {
  StaffToolFrame,
  ToolUnavailable,
} from '@/components/staff-tools/staff-tool-frame';
import { listApiKeys } from '@/domains/api-keys';
import { PERMISSION_CATALOG, isPermission } from '@/lib/permissions/catalog';
import { stringList } from '@/lib/staff/json-list';
import { loadToolPage } from '@/lib/staff/load-tool-page';

export const metadata: Metadata = { title: 'API keys — BlakPath' };

const description =
  'Create a key for a system that acts with a subset of your permissions. The secret is shown once. Revoking a key stops it immediately.';

export default async function ApiKeysPage() {
  const loaded = await loadToolPage('/settings/api-keys', async (ctx) => {
    const rows = await listApiKeys();
    const items: ApiKeyListItem[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: stringList(row.scopes),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
    const scopes: ApiKeyScopeOption[] = [...ctx.permissions]
      .filter(isPermission)
      .map((key) => ({ key, description: PERMISSION_CATALOG[key].description }))
      .sort((left, right) => left.description.localeCompare(right.description));
    return { items, scopes };
  });

  return (
    <StaffToolFrame title="API keys" description={description}>
      {loaded.kind === 'ready' ? (
        <ApiKeysPanel items={loaded.data.items} scopes={loaded.data.scopes} />
      ) : (
        <ToolUnavailable kind={loaded.kind} />
      )}
    </StaffToolFrame>
  );
}
