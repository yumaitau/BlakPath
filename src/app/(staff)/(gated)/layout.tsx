import type { ReactNode } from 'react';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { db } from '@/db/client';
import { organisations } from '@/db/schema';
import { checkStaffMfa } from '@/lib/auth/staff-policy';
import { getServerSession } from '@/lib/auth/session';
import { getActiveOrganisationId } from '@/lib/tenancy/memberships';

/**
 * Staff screens that touch tenant data. Account security stays outside this
 * group so a person can enrol a passkey or authenticator before anything else
 * in a provisioned organisation will render.
 */
export default async function GatedStaffLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');

  const activeOrganisationId = getActiveOrganisationId(session);
  if (!activeOrganisationId) redirect('/select-organisation');

  const [organisation] = await db
    .select({ staffMfaRequired: organisations.staffMfaRequired })
    .from(organisations)
    .where(eq(organisations.id, activeOrganisationId))
    .limit(1);
  if (organisation?.staffMfaRequired) {
    const decision = await checkStaffMfa(session.user.id);
    if (!decision.satisfied) redirect('/settings/security');
  }

  return children;
}
