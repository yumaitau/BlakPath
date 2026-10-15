import type { Metadata } from 'next';
import Link from 'next/link';
import { EvidenceUpload } from '@/components/portal/evidence-upload';
import { WithdrawApplication } from '@/components/portal/withdraw-application';
import { getApplicantPortal, type ApplicantPortalView } from '@/domains/portal';
import { withRequestTenant } from '@/lib/http/tenant-route';

export const metadata: Metadata = {
  title: 'Your application',
};

function displayDate(value: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export default async function ApplicantApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let view: ApplicantPortalView | null = null;
  try {
    view = await withRequestTenant(() => getApplicantPortal(id));
  } catch {
    view = null;
  }

  if (!view) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Application unavailable</h1>
        <p className="text-muted-foreground mt-2">
          This application is not available on your account.
        </p>
        <p className="mt-4">
          <Link href="/portal" className="font-medium underline underline-offset-4">
            Back to your applications
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <p className="text-sm">
        <Link href="/portal" className="underline underline-offset-4">
          Your applications
        </Link>
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{view.reference}</h1>
      <p className="mt-1">{view.applicantName}</p>

      <section className="mt-8" aria-labelledby="recorded-status">
        <h2 id="recorded-status" className="text-lg font-semibold">
          Recorded status
        </h2>
        <p className="mt-2">{view.statusLabel}</p>
        <p className="text-muted-foreground mt-2 text-sm">
          This is the status a person at the organisation recorded. BlakPath does not
          estimate how long it will take, and it does not predict an outcome.
        </p>
      </section>

      <section className="mt-8" aria-labelledby="recorded-history">
        <h2 id="recorded-history" className="text-lg font-semibold">
          What has been recorded
        </h2>
        {view.timeline.length === 0 ? (
          <p className="text-muted-foreground mt-2">No status has been recorded yet.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-3">
            {view.timeline.map((entry) => (
              <li key={entry.id} className="border-border rounded-lg border p-3">
                <p>{entry.summary}</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  {entry.statusLabel}. {displayDate(entry.occurredAt)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-8" aria-labelledby="open-requests">
        <h2 id="open-requests" className="text-lg font-semibold">
          Information the organisation has asked for
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          These are requests a person at the organisation recorded. A due date, when there
          is one, was set by them.
        </p>
        {view.openRequests.length === 0 ? (
          <p className="mt-3">Nothing has been asked of you right now.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-4">
            {view.openRequests.map((request) => (
              <li key={request.id} className="border-border rounded-lg border p-4">
                <p>{request.description}</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  Asked {displayDate(request.askedAt)}
                  {request.dueAt ? `. Due ${displayDate(request.dueAt)}` : ''}
                </p>
                <EvidenceUpload
                  applicationId={view.id}
                  fulfilsRequestId={request.id}
                  inputId={`request-file-${request.id}`}
                  label="File for this request"
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="send-document">
        <h2 id="send-document" className="text-lg font-semibold">
          Send a document
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          You can send a document when you are ready. You do not have to send anything
          that has not been asked for.
        </p>
        <EvidenceUpload
          applicationId={view.id}
          inputId="evidence-file"
          label="Upload supporting evidence"
        />
      </section>

      <section className="mt-8" aria-labelledby="shared-notes">
        <h2 id="shared-notes" className="text-lg font-semibold">
          Messages shared with you
        </h2>
        {view.sharedNotes.length === 0 ? (
          <p className="text-muted-foreground mt-2">
            No messages have been shared with you yet.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {view.sharedNotes.map((note) => (
              <li key={note.id} className="border-border rounded-lg border p-3">
                <p className="whitespace-pre-wrap">{note.body}</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  {displayDate(note.sharedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.outcome ? (
        <section className="mt-8" aria-labelledby="recorded-outcome">
          <h2 id="recorded-outcome" className="text-lg font-semibold">
            Recorded outcome
          </h2>
          <p className="mt-2">{view.outcome.label}</p>
          {view.outcome.rationale ? (
            <p className="mt-2 whitespace-pre-wrap">{view.outcome.rationale}</p>
          ) : null}
          {view.outcome.recordedAt ? (
            <p className="text-muted-foreground mt-1 text-sm">
              Recorded {displayDate(view.outcome.recordedAt)}
            </p>
          ) : null}
          <p className="text-muted-foreground mt-2 text-sm">
            Authorised people at the organisation recorded this. BlakPath did not decide
            it.
          </p>
        </section>
      ) : null}

      {view.canWithdraw ? (
        <section className="mt-10" aria-labelledby="withdraw-application">
          <h2 id="withdraw-application" className="text-lg font-semibold">
            Withdraw
          </h2>
          <p className="text-muted-foreground mt-2 text-sm">
            You can withdraw this application if you want to. The organisation will see
            that you withdrew it. The record is kept. Withdrawing does not delete what you
            have already sent.
          </p>
          <WithdrawApplication applicationId={view.id} />
          <p className="mt-4 text-sm">
            <Link href="/support" className="underline underline-offset-4">
              Get support
            </Link>
          </p>
        </section>
      ) : null}
    </>
  );
}
