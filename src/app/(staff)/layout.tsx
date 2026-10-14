import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SessionWatch } from '@/components/auth/session-watch';
import { TenantKeyUnavailable } from '@/components/encryption/tenant-key-unavailable';
import { StaffShell } from '@/components/staff/staff-shell';
import { OrganisationUnavailable } from '@/components/tenancy/organisation-unavailable';
import {
  membershipRequiresStaffMfa,
  requireStaffMfa,
  STAFF_MFA_ENROL_PATH,
  StaffMfaRequiredError,
} from '@/lib/auth/staff-policy';
import { getOrganisationKey } from '@/domains/organisation-keys';
import { env } from '@/lib/env';
import { clientIp } from '@/lib/http/client-ip';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { visibleStaffTools } from '@/lib/navigation/staff-tools';
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
  const shell = await loadStaffShell();
  // A suspended or closed organisation is refused before the MFA and key
  // checks. The message does not name the status.
  if (shell.unavailable) return <OrganisationUnavailable canSwitch={shell.canSwitch} />;
  const { session, organisations, activeOrganisationId } = shell;

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

  let tools: { href: string; label: string }[] = [];
  try {
    tools = await withRequestTenant((ctx) =>
      visibleStaffTools(ctx.permissions).map(({ href, label }) => ({ href, label })),
    );
  } catch {
    tools = [];
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <StaffShell
        organisations={organisations}
        activeOrganisationId={activeOrganisationId}
        tools={tools}
      />
      <main id="main-content" tabIndex={-1} className="flex-1">
        {locked ? <TenantKeyUnavailable status={locked} /> : children}
      </main>
      <SessionWatch idleTimeoutMinutes={env.STAFF_IDLE_TIMEOUT_MINUTES} />
    </div>
  );
}
