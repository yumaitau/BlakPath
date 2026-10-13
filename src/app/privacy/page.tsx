import Link from 'next/link';

export default function PrivacyPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6"
    >
      <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>
      <div className="text-muted-foreground mt-6 space-y-5 leading-7">
        <p>
          BlakPath is a record-keeping tool for authorised organisations. It never
          decides, scores or infers a person’s Aboriginality.
        </p>
        <p>
          Each organisation controls its own records. Access is limited by organisation
          membership and role, and sensitive actions are recorded in a tamper-evident
          audit trail.
        </p>
        <p>
          Data and backups are intended to remain in Australia. Evidence is held in
          quarantine until it has passed malware scanning, and is not made available while
          it is unscanned.
        </p>
        <p>
          Sensitive records are encrypted under a key held for each organisation. An
          organisation can hold that key itself and turn it off at any time. See{' '}
          <Link href="/key-custody" className="text-primary underline underline-offset-4">
            key custody
          </Link>{' '}
          for who can see what and how to revoke a key.
        </p>
        <p>
          For a privacy request or concern, contact the organisation that holds the
          record. Technical privacy architecture is described in the project
          documentation.
        </p>
      </div>
    </main>
  );
}
