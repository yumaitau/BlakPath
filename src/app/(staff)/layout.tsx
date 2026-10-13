import { getSessionCookie } from 'better-auth/cookies';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { SessionWatch } from '@/components/auth/session-watch';
import { StaffShell } from '@/components/staff/staff-shell';
import {
  CURRENT_PATH_HEADER,
  selectOrganisationPath,
  signInPath,
} from '@/lib/auth/return-to';
import { getServerSession } from '@/lib/auth/session';
import { env } from '@/lib/env';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
} from '@/lib/tenancy/memberships';

/**
 * Authenticated staff shell. This is the UI guard as well as the navigation
 * surface: no staff route renders until the session and active membership have
 * been checked against the database.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const h = await headers();
  // The page being requested, so sign-in and the organisation picker can send
  // the person back to it (validated by `safeReturnTo` before any use).
  const currentPath = h.get(CURRENT_PATH_HEADER);

  const session = await getServerSession();
  if (!session) {
    // A leftover session cookie with no live session means it expired
    // (presence check only — it is never trusted for access); this only changes
    // the notice shown at sign-in.
    const expired = getSessionCookie(h, { cookiePrefix: 'blakpath' }) !== null;
    redirect(signInPath(currentPath, expired ? 'expired' : undefined));
  }

  const activeOrganisationId = getActiveOrganisationId(session);
  if (!activeOrganisationId) redirect(selectOrganisationPath(currentPath));

  const organisations = await listMembershipsForUser(session.user.id);
  // A stale session can name a membership that was revoked after sign-in. Treat
  // it exactly like no selection, instead of rendering a misleading shell.
  if (!organisations.some((org) => org.organisationId === activeOrganisationId)) {
    redirect(selectOrganisationPath(currentPath));
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
      <SessionWatch idleTimeoutMinutes={env.STAFF_IDLE_TIMEOUT_MINUTES} />
    </div>
  );
}
