import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { OrganisationUnavailable } from '@/components/tenancy/organisation-unavailable';
import { getServerSession } from '@/lib/auth/session';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
  organisationAccessForUser,
} from '@/lib/tenancy/memberships';

/**
 * Applicant shell.
 *
 * Separate from the staff shell on purpose. Navigation here is only the
 * person's own applications. Staff links are not rendered.
 */
export default async function ApplicantLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect('/sign-in?returnTo=/portal');

  const activeOrganisationId = getActiveOrganisationId(session);
  if (!activeOrganisationId) redirect('/select-organisation');
  const organisations = await listMembershipsForUser(session.user.id);
  // Same organisation-status gate as the staff shell. The copy does not name
  // the status.
  const access = await organisationAccessForUser(session.user.id, activeOrganisationId);
  if (access === 'unavailable') {
    return <OrganisationUnavailable canSwitch={organisations.length > 0} />;
  }
  const current = organisations.find(
    (org) => org.organisationId === activeOrganisationId,
  );
  if (!current) redirect('/select-organisation');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-border bg-surface border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div>
            <Link href="/portal" className="text-lg font-semibold tracking-tight">
              <span className="text-primary">Blak</span>Path
            </Link>
            <p className="text-muted-foreground text-sm">{current.organisationName}</p>
          </div>
          <div className="flex items-center gap-2">
            {organisations.length > 1 ? (
              <Link
                href="/select-organisation?choose=1"
                className="text-sm font-medium underline underline-offset-4"
              >
                Choose another organisation
              </Link>
            ) : null}
            <SignOutButton />
          </div>
        </div>
        <nav
          aria-label="Your application"
          className="mx-auto max-w-3xl px-4 pb-3 sm:px-6"
        >
          <Link
            href="/portal"
            className="text-sm font-semibold underline-offset-4 hover:underline"
          >
            Your applications
          </Link>
        </nav>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6"
      >
        {children}
      </main>
    </div>
  );
}
