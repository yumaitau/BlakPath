import type { Metadata } from 'next';
import Link from 'next/link';
import { StartApplicationForm } from '@/components/portal/start-application-form';
import { Button } from '@/components/ui/button';
import { getPublicOrganisationBySlug } from '@/domains/organisations';
import { getServerSession } from '@/lib/auth/session';

export const metadata: Metadata = {
  title: 'Start an application',
};

export default async function StartApplicationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const organisation = await getPublicOrganisationBySlug(slug);

  if (!organisation) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6"
      >
        <h1 className="text-3xl font-semibold tracking-tight">
          Applications are not open
        </h1>
        <p className="text-muted-foreground mt-4 leading-7">
          This organisation is not taking applications through BlakPath at the moment.
        </p>
        <p className="mt-6">
          <Link
            href="/organisations"
            className="font-medium underline underline-offset-4"
          >
            Back to organisations
          </Link>
        </p>
      </main>
    );
  }

  const session = await getServerSession();
  const returnTo = `/organisations/${organisation.slug}/apply`;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6"
    >
      <h1 className="text-3xl font-semibold tracking-tight">Start an application</h1>
      <p className="mt-3 text-lg">{organisation.name}</p>
      <div className="text-muted-foreground mt-4 space-y-4 leading-7">
        <p>
          You can start an application with {organisation.name}. People at that
          organisation look at it. BlakPath does not decide the outcome, and it does not
          determine Aboriginality.
        </p>
        <p>
          If you do not have an account yet, ask the organisation to invite you. Accounts
          are invitation only.
        </p>
      </div>
      {session ? (
        <StartApplicationForm
          slug={organisation.slug}
          organisationName={organisation.name}
        />
      ) : (
        <div className="mt-8">
          <Button asChild>
            <Link href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>
              Sign in to start
            </Link>
          </Button>
        </div>
      )}
    </main>
  );
}
