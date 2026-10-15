import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { listPublicOrganisations } from '@/domains/organisations';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Find an organisation',
};

export default async function OrganisationsPage() {
  const organisations = await listPublicOrganisations();

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6"
    >
      <h1 className="text-3xl font-semibold tracking-tight">Find an organisation</h1>
      <div className="text-muted-foreground mt-6 space-y-5 leading-7">
        <p>
          Confirmation processes are controlled by the relevant Aboriginal or Torres
          Strait Islander organisation. BlakPath does not decide which organisation is
          right for a person, and it does not make identity determinations.
        </p>
        <p>
          Organisations that have chosen to take applications here are listed below, in
          alphabetical order. The list is not a recommendation.
        </p>
        <p>
          If you are unsure who to contact, seek guidance from a local Aboriginal
          Community Controlled Organisation or the organisation that asked you to provide
          confirmation.
        </p>
      </div>

      {organisations.length === 0 ? (
        <p className="mt-8">
          No organisation is taking applications through BlakPath right now. If someone
          asked you to apply, contact that organisation directly.
        </p>
      ) : (
        <ul className="mt-8 flex flex-col gap-4">
          {organisations.map((organisation) => (
            <li key={organisation.id} className="border-border rounded-lg border p-4">
              <h2 className="text-lg font-semibold">{organisation.name}</h2>
              {organisation.organisationType ? (
                <p className="text-muted-foreground mt-1 text-sm">
                  {organisation.organisationType}
                </p>
              ) : null}
              <p className="mt-3">
                <Link
                  href={`/organisations/${organisation.slug}/apply`}
                  className="font-medium underline underline-offset-4"
                >
                  Start an application with {organisation.name}
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}

      <Button asChild variant="outline" className="mt-7">
        <Link href="/support">Get support</Link>
      </Button>
    </main>
  );
}
