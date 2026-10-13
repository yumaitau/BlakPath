import type { Metadata } from 'next';
import { OrganisationSettingsEditor } from '@/components/settings/organisation-settings-editor';
import {
  getOrganisationSettings,
  listOrganisationDomains,
} from '@/domains/organisation-settings';
import { withRequestTenant } from '@/lib/http/tenant-route';

export const metadata: Metadata = {
  title: 'Organisation settings — BlakPath',
};

export default async function OrganisationSettingsPage() {
  let loaded: Awaited<ReturnType<typeof load>> | null = null;
  try {
    loaded = await withRequestTenant(() => load());
  } catch {
    loaded = null;
  }
  if (!loaded) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        Only organisation administrators can manage organisation settings.
      </p>
    );
  }
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <OrganisationSettingsEditor
        initialSettings={loaded.settings}
        initialDomains={loaded.domains}
      />
    </div>
  );
}

function load() {
  return Promise.all([getOrganisationSettings(), listOrganisationDomains()]).then(
    ([settings, domains]) => ({ settings, domains }),
  );
}
