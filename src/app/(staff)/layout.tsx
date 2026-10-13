import type { ReactNode } from 'react';
import { TenantKeyUnavailable } from '@/components/encryption/tenant-key-unavailable';
import { StaffShell } from '@/components/staff/staff-shell';
import { getOrganisationKey } from '@/domains/organisation-keys';
import { loadStaffShell } from '@/lib/tenancy/staff-shell';

/**
 * Authenticated staff shell. This is the UI guard as well as the navigation
 * surface: no staff route renders until the session and active membership have
 * been checked against the database.
 *
 * A tenant key that is not active locks every page here. The encryption-keys
 * settings page lives in the `(key-custody)` group so an administrator can
 * still see the key's status and check it while records are locked.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const { organisations, activeOrganisationId } = await loadStaffShell();

  const key = await getOrganisationKey(activeOrganisationId);
  const locked = key && key.status !== 'active' ? key.status : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <StaffShell
        organisations={organisations}
        activeOrganisationId={activeOrganisationId}
      />
      <main id="main-content" tabIndex={-1} className="flex-1">
        {locked ? <TenantKeyUnavailable status={locked} /> : children}
      </main>
    </div>
  );
}
