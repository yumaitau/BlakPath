import { redirect } from 'next/navigation';
import { destinationForRoles } from '@/lib/auth/landing';
import { getServerSession } from '@/lib/auth/session';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
  listRoleSlugsForUserOrganisation,
} from '@/lib/tenancy/memberships';

/**
 * Post-sign-in router. Applicant-only memberships go to the portal. Everyone
 * else goes to the staff dashboard. This page renders nothing.
 */
export default async function HomePage() {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');

  const activeOrganisationId = getActiveOrganisationId(session);
  const organisations = await listMembershipsForUser(session.user.id);
  if (
    !activeOrganisationId ||
    !organisations.some((org) => org.organisationId === activeOrganisationId)
  ) {
    redirect('/select-organisation');
  }

  const roleSlugs = await listRoleSlugsForUserOrganisation(
    session.user.id,
    activeOrganisationId,
  );
  redirect(destinationForRoles(roleSlugs));
}
