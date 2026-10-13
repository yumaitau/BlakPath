import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { StaffShell } from '@/components/staff/staff-shell';
import { OrganisationUnavailable } from '@/components/tenancy/organisation-unavailable';
import { getServerSession } from '@/lib/auth/session';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
  organisationAccessForUser,
} from '@/lib/tenancy/memberships';

/**
 * Authenticated staff shell. This is the UI guard as well as the navigation
 * surface: no staff route renders until the session and active membership have
 * been checked against the database.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');

  const activeOrganisationId = getActiveOrganisationId(session);
  if (!activeOrganisationId) redirect('/select-organisation');

  const organisations = await listMembershipsForUser(session.user.id);
  // An active membership of a suspended or closed organisation is refused here,
  // before any staff page renders. The message does not name the status.
  const access = await organisationAccessForUser(session.user.id, activeOrganisationId);
  if (access === 'unavailable') {
    return <OrganisationUnavailable canSwitch={organisations.length > 0} />;
  }
  // A stale session can name a membership that was revoked after sign-in. Treat
  // it exactly like no selection, instead of rendering a misleading shell.
  if (!organisations.some((org) => org.organisationId === activeOrganisationId)) {
    redirect('/select-organisation');
  }

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
