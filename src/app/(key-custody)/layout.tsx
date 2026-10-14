import type { ReactNode } from 'react';
import { StaffShell } from '@/components/staff/staff-shell';
import { loadStaffShell } from '@/lib/tenancy/staff-shell';

/**
 * Staff shell without the tenant-key lock. Only the encryption-keys settings
 * page belongs here: it reads key status and audit events, never encrypted
 * records, so it must stay reachable while the key is unavailable.
 */
export default async function KeyCustodyLayout({ children }: { children: ReactNode }) {
  const { organisations, activeOrganisationId } = await loadStaffShell();
  return (
    <div className="flex min-h-dvh flex-col">
      <StaffShell
        organisations={organisations}
        activeOrganisationId={activeOrganisationId}
      />
      <main id="main-content" tabIndex={-1} className="flex-1">
        {children}
      </main>
    </div>
  );
}
