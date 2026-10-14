import { getSessionCookie } from 'better-auth/cookies';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  CURRENT_PATH_HEADER,
  selectOrganisationPath,
  signInPath,
} from '@/lib/auth/return-to';
import { getServerSession, type ServerSession } from '@/lib/auth/session';
import { isApplicantOnlyRoleSet } from '@/lib/permissions/roles';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
  listRoleSlugsForUserOrganisation,
  organisationAccessForUser,
  type UserMembership,
} from './memberships';

export type StaffShellData =
  | {
      readonly unavailable: false;
      readonly session: ServerSession;
      readonly organisations: UserMembership[];
      readonly activeOrganisationId: string;
    }
  | {
      /** Active membership of a suspended or closed organisation. */
      readonly unavailable: true;
      /** The user has another operational organisation to switch to. */
      readonly canSwitch: boolean;
    };

/**
 * Session and membership guard shared by the staff layouts. No staff route
 * renders until the session, active membership and organisation status have
 * been checked against the database.
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
  // An active membership of a suspended or closed organisation is refused
  // before any staff page renders. The caller shows a generic message that does
  // not name the status.
  const access = await organisationAccessForUser(session.user.id, activeOrganisationId);
  if (access === 'unavailable') {
    return { unavailable: true, canSwitch: organisations.length > 0 };
  }
  // A stale session can name a membership that was revoked after sign-in. Treat
  // it exactly like no selection, instead of rendering a misleading shell.
  if (!organisations.some((org) => org.organisationId === activeOrganisationId)) {
    redirect(selectOrganisationPath(currentPath));
  }
  // An applicant-only membership never receives staff navigation, even on a
  // direct /dashboard request. Redirect before the MFA gate and the shell.
  const roleSlugs = await listRoleSlugsForUserOrganisation(
    session.user.id,
    activeOrganisationId,
  );
  if (isApplicantOnlyRoleSet(roleSlugs)) redirect('/portal');
  return { unavailable: false, session, organisations, activeOrganisationId };
}
