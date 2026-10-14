import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/auth/session';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
  type UserMembership,
} from './memberships';

export interface StaffShellData {
  readonly organisations: UserMembership[];
  readonly activeOrganisationId: string;
}

/**
 * Session and membership guard shared by the staff layouts. No staff route
 * renders until the session and active membership have been checked against
 * the database.
 */
export async function loadStaffShell(): Promise<StaffShellData> {
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
  return { organisations, activeOrganisationId };
}
