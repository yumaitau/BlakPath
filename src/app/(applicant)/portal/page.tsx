import type { Metadata } from 'next';
import Link from 'next/link';
import { listOwnApplications } from '@/domains/portal';
import { withRequestTenant } from '@/lib/http/tenant-route';

export const metadata: Metadata = {
  title: 'Your applications',
};

export default async function ApplicantPortalPage() {
  let applications: Awaited<ReturnType<typeof listOwnApplications>> | null = null;
  try {
    applications = await withRequestTenant(() => listOwnApplications());
  } catch {
    applications = null;
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Your applications</h1>
      <p className="text-muted-foreground mt-2 max-w-2xl">
        These are applications linked to your account with this organisation. The status
        is what a person there recorded. BlakPath does not estimate timing or predict an
        outcome.
      </p>

      {applications === null ? (
        <p className="mt-8">
          This page is for people with an application on their own account. Your account
          does not include that access.
        </p>
      ) : applications.length === 0 ? (
        <div className="mt-8">
          <p>You do not have an application with this organisation yet.</p>
          <p className="mt-3">
            <Link
              href="/organisations"
              className="font-medium underline underline-offset-4"
            >
              Find an organisation
            </Link>
          </p>
        </div>
      ) : (
        <ul className="mt-8 flex flex-col gap-3">
          {applications.map((application) => (
            <li key={application.id} className="border-border rounded-lg border p-4">
              <Link
                href={`/portal/${application.id}`}
                className="font-semibold underline-offset-4 hover:underline"
              >
                {application.reference}
                <span className="mt-1 block text-sm font-normal">
                  {application.applicantName}
                </span>
                <span className="text-muted-foreground mt-1 block text-sm font-normal">
                  {application.statusLabel}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
