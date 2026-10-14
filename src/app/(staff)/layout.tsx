import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { TenantKeyUnavailable } from '@/components/encryption/tenant-key-unavailable';
import { StaffShell } from '@/components/staff/staff-shell';
import {
  membershipRequiresStaffMfa,
  requireStaffMfa,
  STAFF_MFA_ENROL_PATH,
  StaffMfaRequiredError,
} from '@/lib/auth/staff-policy';
import { getOrganisationKey } from '@/domains/organisation-keys';
import { getServerSession } from '@/lib/auth/session';
import { clientIp } from '@/lib/http/client-ip';
import { loadStaffShell } from '@/lib/tenancy/staff-shell';

/**
 * Authenticated staff shell. This is the UI guard as well as the navigation
 * surface: no staff route renders until the session, active membership and
 * staff second-factor policy have been checked against the database.
 *
 * A tenant key that is not active locks every page here. The encryption-keys
 * settings page lives in the `(key-custody)` group so an administrator can
 * still see the key's status and check it while records are locked.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');

  const { organisations, activeOrganisationId } = await loadStaffShell();

  if (await membershipRequiresStaffMfa(session.user.id, activeOrganisationId)) {
    const h = await headers();
    try {
      await requireStaffMfa(session.user.id, {
        organisationId: activeOrganisationId,
        sessionId: session.session.id,
        ipAddress: clientIp({ headers: h }),
        userAgent: h.get('user-agent'),
      });
    } catch (error) {
      if (error instanceof StaffMfaRequiredError) redirect(STAFF_MFA_ENROL_PATH);
      throw error;
    }
  }

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
