import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { getServerSession } from '@/lib/auth/session';
import {
  requireStaffMfa,
  STAFF_MFA_ENROL_PATH,
  StaffMfaRequiredError,
} from '@/lib/auth/staff-policy';
import { clientIp } from '@/lib/http/client-ip';

/**
 * Platform-operator shell. No organisation membership is required.
 * The operator flag is read from the database, not from the session payload.
 * Platform operators must satisfy the staff second-factor policy.
 */
export default async function OperatorLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');

  const rows = await db
    .select({ isPlatformOperator: users.isPlatformOperator })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (!rows[0]?.isPlatformOperator) redirect('/');

  const h = await headers();
  try {
    await requireStaffMfa(session.user.id, {
      organisationId: null,
      sessionId: session.session.id,
      actingRole: 'platform-operator',
      ipAddress: clientIp({ headers: h }),
      userAgent: h.get('user-agent'),
    });
  } catch (error) {
    if (error instanceof StaffMfaRequiredError) redirect(STAFF_MFA_ENROL_PATH);
    throw error;
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-8 sm:px-6">
      <header className="mb-8 flex items-center justify-between gap-3">
        <Link
          href="/operator/break-glass"
          className="text-lg font-semibold tracking-tight"
        >
          <span className="text-primary">Blak</span>Path operator
        </Link>
        <SignOutButton variant="outline" size="sm" />
      </header>
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
