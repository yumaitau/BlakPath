import { getSessionCookie } from 'better-auth/cookies';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  CURRENT_PATH_HEADER,
  selectOrganisationPath,
  signInPath,
} from '@/lib/auth/return-to';
import { getServerSession, type ServerSession } from '@/lib/auth/session';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
  type UserMembership,
} from './memberships';

export interface StaffShellData {
  readonly session: ServerSession;
  readonly organisations: UserMembership[];
  readonly activeOrganisationId: string;
}

/**
 * Session and membership guard shared by the staff layouts. No staff route
 * renders until the session and active membership have been checked against
 * the database.
 *
 * Redirects carry the requested page as `returnTo` (validated by
 * `safeReturnTo` before any use) so sign-in and the organisation picker can
 * send the person back to it.
 */
export async function loadStaffShell(): Promise<StaffShellData> {
  const h = await headers();
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
  return { session, organisations, activeOrganisationId };
}
