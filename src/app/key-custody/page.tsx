import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/alert';

export const metadata: Metadata = {
  title: 'Key custody — BlakPath',
  description:
    'Who holds the key that protects an organisation’s records, how to revoke it, and how to check.',
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-foreground text-xl font-semibold">{title}</h2>
      <div className="mt-3 space-y-4">{children}</div>
    </section>
  );
}

/**
 * Public summary of the client trust pack (`docs/customer-held-keys.md`).
 * Draft wording until counsel and a pilot council have reviewed it.
 */
export default function KeyCustodyPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6"
    >
      <h1 className="text-3xl font-semibold tracking-tight">Key custody</h1>
      <div className="mt-6">
        <Alert tone="warning" role="status" title="Draft">
          This page is a draft. It is waiting for review by legal counsel and a pilot
          council, and is not yet a contractual statement.
        </Alert>
      </div>

      <div className="text-muted-foreground leading-7">
        <Section title="How a key protects records">
          <p>
            Each protected value is encrypted with its own data key. That data key is
            wrapped by the organisation&rsquo;s key in AWS Key Management Service, in
            Sydney. BlakPath stores only the wrapped copy and must ask the key to unwrap
            it, so an organisation that holds its own key can stop BlakPath reading those
            records at any time.
          </p>
          <p>
            Every use of the key names the organisation it is for, so one
            organisation&rsquo;s key can never open another&rsquo;s records. Some data,
            such as evidence files and database backups, is protected by BlakPath&rsquo;s
            platform keys rather than the organisation&rsquo;s key. Ask for the coverage
            list for the current release.
          </p>
        </Section>

        <Section title="Who can see what">
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong className="text-foreground">Managed by BlakPath.</strong> The key is
              in BlakPath&rsquo;s AWS account and used only for that organisation.
              BlakPath disables it on a written request.
            </li>
            <li>
              <strong className="text-foreground">Held by the organisation.</strong> The
              key is in the organisation&rsquo;s own AWS account or external key store.
              The organisation can turn it off without asking BlakPath, and sees every use
              of it in its own AWS logs.
            </li>
            <li>
              <strong className="text-foreground">
                Held by the organisation, with escrow.
              </strong>{' '}
              As above, plus an optional escrow copy held by BlakPath under dual control,
              released only on a written request from the organisation&rsquo;s authorised
              signatories.
            </li>
          </ul>
          <p>
            While a key is turned on, the BlakPath application reads records in memory to
            serve the organisation&rsquo;s authorised staff. BlakPath staff have no
            routine access; emergency access is time-limited, approved by the organisation
            and recorded. AWS runs the key service but does not see record content.
          </p>
        </Section>

        <Section title="Revoking a key">
          <p>
            An organisation that holds its own key can disable it, remove BlakPath&rsquo;s
            permission, or schedule it for deletion. Within five minutes BlakPath can no
            longer open records protected by that key. Staff see &ldquo;Records are
            locked&rdquo;; nothing is shown under another key, nothing is deleted, and
            other organisations are unaffected. Turning the key back on and running a
            check from Settings &rarr; Encryption keys restores access.
          </p>
        </Section>

        <Section title="Crypto-shredding">
          <p>
            Deleting the key makes every record it protected permanently unreadable,
            including copies in backups, because backups hold only wrapped data keys. Data
            protected by platform keys is removed through offboarding and backup expiry
            instead. With escrow, the escrow copy must also be destroyed.
          </p>
        </Section>

        <Section title="Checking for yourself">
          <p>
            Organisation administrators can see the key, its status, its last health
            check, escrow status and its full change history on Settings &rarr; Encryption
            keys. Every view and check is recorded. The full trust pack describes
            step-by-step checks a council auditor can carry out in their own AWS account,
            including a revoke-and-restore test.
          </p>
        </Section>

        <p className="mt-10">
          See also <Link href="/privacy">Privacy</Link>. BlakPath never decides, scores or
          infers a person&rsquo;s Aboriginality; keys protect records and change nothing
          about who decides.
        </p>
      </div>
    </main>
  );
}
