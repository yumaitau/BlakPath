import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/auth/session';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
  organisationAccessForUser,
  type UserMembership,
} from './memberships';

export type StaffShellData =
  | {
      readonly unavailable: false;
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
 */
export async function loadStaffShell(): Promise<StaffShellData> {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');

  const activeOrganisationId = getActiveOrganisationId(session);
  if (!activeOrganisationId) redirect('/select-organisation');

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
    redirect('/select-organisation');
  }
  return { unavailable: false, organisations, activeOrganisationId };
}
