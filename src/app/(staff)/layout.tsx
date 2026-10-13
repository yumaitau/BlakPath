import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { StaffShell } from '@/components/staff/staff-shell';
import { getServerSession } from '@/lib/auth/session';
import { isApplicantOnlyRoleSet } from '@/lib/permissions/roles';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
  listRoleSlugsForUserOrganisation,
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
  // A stale session can name a membership that was revoked after sign-in. Treat
  // it exactly like no selection, instead of rendering a misleading shell.
  if (!organisations.some((org) => org.organisationId === activeOrganisationId)) {
    redirect('/select-organisation');
  }

  // Redirect before the staff shell is rendered. An applicant-only membership
  // must not receive staff navigation, even on a direct /dashboard request.
  const roleSlugs = await listRoleSlugsForUserOrganisation(
    session.user.id,
    activeOrganisationId,
  );
  if (isApplicantOnlyRoleSet(roleSlugs)) redirect('/portal');

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
