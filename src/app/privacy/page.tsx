import { COMPLAINT_ESCALATION_TEXT } from '@/domains/privacy/rules';

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
          For a privacy request or concern, contact the organisation that holds the
          record. Technical privacy architecture is described in the project
          documentation.
        </p>
        <h2 className="text-foreground pt-4 text-xl font-semibold">Your rights</h2>
        <p>
          You can ask the organisation for a copy of the information it holds about you,
          ask for it to be corrected, withdraw a consent you gave, ask for information to
          be erased, or make a complaint. The organisation records your request and
          responds within 30 days.
        </p>
        <p>
          If the organisation declines to correct something, you can ask for your own
          statement to be kept with the record. Official records, such as a recorded
          decision or an issued certificate, are kept as the law requires even after other
          information is erased.
        </p>
        <p className="whitespace-pre-line">{COMPLAINT_ESCALATION_TEXT}</p>
      </div>
    </main>
  );
}
