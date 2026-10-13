import { Building2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { OrganisationPicker } from '@/components/tenancy/organisation-picker';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { safeReturnTo, signInPath } from '@/lib/auth/return-to';
import { getServerSession } from '@/lib/auth/session';
import {
  getActiveOrganisationId,
  listMembershipsForUser,
} from '@/lib/tenancy/memberships';

export const metadata: Metadata = {
  title: 'Choose an organisation — BlakPath',
};

/**
 * A pre-tenant route, intentionally outside the guarded staff route group.
 * `returnTo` (the page a fresh or expired session was heading for) is
 * validated, then used as the destination once an organisation is chosen.
 */
export default async function SelectOrganisationPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const requested = (await searchParams).returnTo;
  const returnTo = safeReturnTo(typeof requested === 'string' ? requested : null);
  const session = await getServerSession();
  if (!session) {
    return (
      <div className="bg-surface-muted flex min-h-dvh items-center justify-center px-4 py-12">
        <div className="border-border bg-surface w-full max-w-xl rounded-xl border p-6 shadow-md sm:p-8">
          <Alert tone="info" title="Please sign in">
            <p>You need to sign in before choosing an organisation.</p>
            <div className="mt-4">
              <Button asChild variant="primary" size="sm">
                <Link href={signInPath(returnTo)}>Sign in</Link>
              </Button>
            </div>
          </Alert>
        </div>
      </div>
    );
  }

  const organisations = await listMembershipsForUser(session.user.id);
  const activeOrganisationId = getActiveOrganisationId(session);
  if (
    activeOrganisationId &&
    organisations.some((org) => org.organisationId === activeOrganisationId)
  ) {
    redirect(returnTo);
  }

  return (
    <div className="bg-surface-muted flex min-h-dvh items-center justify-center px-4 py-12">
      <main className="border-border bg-surface w-full max-w-xl rounded-xl border p-6 shadow-md sm:p-8">
        <p className="text-lg font-semibold tracking-tight">
          <span className="text-primary">Blak</span>Path
        </p>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">
          Choose an organisation
        </h1>
        <p className="text-muted-foreground mt-2">
          Pick the organisation you&apos;re working with today. You can switch at any
          time.
        </p>

        <div className="mt-8">
          {organisations.length === 0 ? (
            <Alert tone="info" title="No organisations yet">
              <div className="flex items-start gap-3">
                <Building2
                  className="text-muted-foreground mt-0.5 size-5 shrink-0"
                  aria-hidden="true"
                />
                <p>
                  You&apos;re not a member of an organisation yet. Ask an administrator to
                  send you an invitation.
                </p>
              </div>
            </Alert>
          ) : (
            <OrganisationPicker
              organisations={organisations.map((org) => ({
                organisationId: org.organisationId,
                organisationName: org.organisationName,
                slug: org.slug,
              }))}
              activeOrganisationId={activeOrganisationId}
              returnTo={returnTo}
            />
          )}
        </div>
      </main>
    </div>
  );
}
