import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SecuritySettings } from '@/components/auth/security-settings';
import { getServerSession } from '@/lib/auth/session';

/**
 * Staff second-factor enrolment.
 *
 * This page is outside the staff shell on purpose. The shell redirects here
 * when a staff account has no verified factor; hosting the form inside that
 * shell would redirect forever. The controls talk only to the auth API.
 */
export const metadata: Metadata = {
  title: 'Enrol a second factor — BlakPath',
};

export default async function StaffMfaEnrolPage() {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');

  return (
    <div className="bg-surface-muted flex min-h-dvh justify-center px-4 py-12">
      <main
        id="main-content"
        tabIndex={-1}
        className="border-border bg-surface w-full max-w-2xl rounded-xl border p-6 shadow-md sm:p-8"
      >
        <p className="text-lg font-semibold tracking-tight">
          <span className="text-primary">Blak</span>Path
        </p>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">
          Enrol a second factor
        </h1>
        <p className="text-muted-foreground mt-2">
          Staff accounts need a passkey or a confirmed authenticator app before opening
          organisation records. Add one below, then return to your work.
        </p>
        <div className="mt-8">
          <SecuritySettings />
        </div>
      </main>
    </div>
  );
}
