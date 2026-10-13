import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ContactValue,
  LegalPage,
  LegalSection,
  legalLinkClass,
} from '@/components/legal/legal-page';
import { OAIC_CONTACT, PLATFORM_CONTACT } from '@/lib/legal/documents';

export const metadata: Metadata = { title: 'Privacy policy' };

/**
 * Platform privacy policy — DRAFT PENDING COUNSEL REVIEW.
 *
 * Layered: a short summary that links into anchored detail sections covering
 * the APP 1.4 matters, plus the automated-decision transparency statement
 * (APP 1.7–1.9, in force from 10 December 2026). Open questions for counsel are
 * tracked in docs/legal-review.md; do not present this as settled text.
 */

const sections = [
  { id: 'who-we-are', title: 'Who is responsible for your information' },
  { id: 'what-we-collect', title: 'What we collect' },
  { id: 'how-we-collect', title: 'How information is collected' },
  { id: 'purposes', title: 'Why information is collected and used' },
  { id: 'automated-decisions', title: 'Automated decisions' },
  { id: 'disclosures', title: 'Who information is disclosed to' },
  { id: 'overseas', title: 'Storage in Australia and overseas disclosure' },
  { id: 'security', title: 'Security and retention' },
  { id: 'access-correction', title: 'Accessing and correcting your information' },
  { id: 'complaints', title: 'Making a privacy complaint' },
  { id: 'contact', title: 'Contact us' },
  { id: 'changes', title: 'Changes to this policy' },
] as const;

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      intro={
        <>
          <p>
            BlakPath is a record-keeping platform used by authorised Aboriginal and Torres
            Strait Islander organisations that administer Confirmation of Aboriginality.
            This policy explains how personal information is handled on the platform.
          </p>
          <h2 className="text-foreground mt-8 text-lg font-semibold">In summary</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              Each organisation controls its own records and decides how requests are
              handled. Ask that organisation first about your record.
            </li>
            <li>
              Information can be sensitive, including information about Aboriginal or
              Torres Strait Islander identity, community connections and family history.
            </li>
            <li>
              Decisions are made by people.{' '}
              <strong className="text-foreground">
                BlakPath makes no automated decisions
              </strong>{' '}
              and never scores, ranks, predicts or decides anyone’s Aboriginality.
            </li>
            <li>Records and backups are stored in Australia.</li>
            <li>
              You can ask to see or correct your information and complain to the OAIC if
              you are not satisfied.
            </li>
          </ul>
          <nav aria-label="Privacy policy sections" className="mt-6">
            <h2 className="text-foreground text-lg font-semibold">In this policy</h2>
            <ol className="mt-3 list-decimal space-y-1 pl-5">
              {sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className={legalLinkClass}>
                    {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </>
      }
    >
      <LegalSection id="who-we-are" title="Who is responsible for your information">
        <p>
          Each organisation that uses BlakPath (an “organisation”) is responsible for the
          personal information it collects and holds in its BlakPath records, under the
          privacy law that applies to it. The organisation decides what it collects, how
          it handles requests and who in the organisation can see a record.
        </p>
        <p>
          The BlakPath platform operator (
          <ContactValue value={PLATFORM_CONTACT.operatorName} />) provides and secures the
          software for those organisations. It handles organisation records only to
          provide the service, and is responsible for the information it holds for its own
          purposes, such as staff account and security information.
        </p>
      </LegalSection>

      <LegalSection id="what-we-collect" title="What we collect">
        <p>Depending on how you use BlakPath, this can include:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Applicants and form recipients:</strong>{' '}
            name, contact details, information you give in forms and applications, and
            documents you or others provide as evidence.
          </li>
          <li>
            <strong className="text-foreground">Sensitive information:</strong>{' '}
            information about racial or ethnic origin (Aboriginal or Torres Strait
            Islander identity), community connections and family history, which can also
            be about other people such as family members.
          </li>
          <li>
            <strong className="text-foreground">Organisation staff and members:</strong>{' '}
            name, email, role, sign-in and multi-factor authentication details.
          </li>
          <li>
            <strong className="text-foreground">Activity and security records:</strong> an
            audit trail of who accessed or changed a record and when, and limited
            technical information such as IP address for security and abuse investigation.
          </li>
          <li>
            <strong className="text-foreground">
              Collection notice acknowledgements:
            </strong>{' '}
            which version of an organisation’s collection notice was shown to you and when
            you acknowledged it.
          </li>
        </ul>
        <p>
          BlakPath does not use advertising or tracking cookies. It uses cookies needed to
          keep you signed in securely.
        </p>
      </LegalSection>

      <LegalSection id="how-we-collect" title="How information is collected">
        <p>
          Most information is collected directly from you by an organisation, through a
          form, an application, an evidence upload or a conversation with its staff. Each
          of these shows the organisation’s collection notice first, and BlakPath keeps a
          record of the version shown. Information can also come from people you
          authorise, such as a representative, or from other people who provide
          information about family history.
        </p>
      </LegalSection>

      <LegalSection id="purposes" title="Why information is collected and used">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            For an organisation to receive, consider and keep a record of requests,
            including Confirmation of Aboriginality, and to contact the people involved.
          </li>
          <li>To issue and let others verify certificates an organisation has issued.</li>
          <li>To secure accounts, prevent misuse and keep an audit trail.</li>
          <li>To meet record-keeping and legal obligations.</li>
          <li>
            To operate, support and improve the service, without selling information.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="automated-decisions" title="Automated decisions">
        <p>
          <strong className="text-foreground">
            BlakPath does not use computer programs to make decisions about people.
          </strong>{' '}
          No computer program in BlakPath makes, or does anything substantially and
          directly related to making, a decision that could reasonably be expected to
          significantly affect your rights or interests.
        </p>
        <p>
          Every decision about a request, including a decision about Confirmation of
          Aboriginality, is made and recorded by authorised people at the organisation.
          BlakPath never scores, ranks, predicts, infers, approves or rejects anyone’s
          identity. Optional AI features are off by default and cannot be used to make or
          recommend such a decision.
        </p>
        <p>
          The software does automate routine administration, such as sending
          notifications, checking uploaded files for malware and checking the digital seal
          on a certificate. If a file is blocked by a malware scan, you can give the
          document to the organisation another way.
        </p>
      </LegalSection>

      <LegalSection id="disclosures" title="Who information is disclosed to">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Authorised people at the organisation that holds the record, such as staff and
            the committee or panel that considers requests.
          </li>
          <li>People you authorise, such as a representative.</li>
          <li>
            Someone checking a certificate you have given them can see whether it is
            valid, but not your application or evidence.
          </li>
          <li>
            Service providers that host and run BlakPath for the operator, only so they
            can provide the service (see below).
          </li>
          <li>Others where you agree, or where the law requires or allows it.</li>
        </ul>
      </LegalSection>

      <LegalSection id="overseas" title="Storage in Australia and overseas disclosure">
        <p>
          BlakPath stores records, uploaded documents and backups in Australia, in the
          Amazon Web Services Sydney region. The platform’s main service providers are its
          cloud hosting and email delivery providers, used in that region.
        </p>
        <p>
          BlakPath does not intentionally disclose records to overseas recipients. The
          full list of service providers, and any that may access information from outside
          Australia (for example for technical support), will be published here before
          production use.
        </p>
      </LegalSection>

      <LegalSection id="security" title="Security and retention">
        <p>
          Access is limited by organisation membership and role, and sensitive actions are
          recorded in a tamper-evident audit trail. Connections are encrypted, and
          uploaded documents are encrypted at rest and held in quarantine until a malware
          scan passes.
        </p>
        <p>
          Each organisation sets how long its records are kept, subject to its legal
          record-keeping obligations. Records are then deleted or de-identified unless
          they are subject to a legal hold.
        </p>
      </LegalSection>

      <LegalSection
        id="access-correction"
        title="Accessing and correcting your information"
      >
        <p>
          You can ask to see the personal information held about you, and ask for it to be
          corrected. Contact the organisation that holds your record first; it is best
          placed to respond. For information the platform operator holds about you, such
          as a staff account, contact us using the details below. We will respond within
          30 days and tell you if we cannot do what you ask and why.
        </p>
      </LegalSection>

      <LegalSection id="complaints" title="Making a privacy complaint">
        <p>
          Raise a complaint with the organisation that holds your record, or with us for
          information the platform operator holds. Tell us what happened and how you would
          like it resolved. We aim to respond within 30 days.
        </p>
        <p>
          If you are not satisfied with the response, you can complain to the{' '}
          <a href={OAIC_CONTACT.url} className={legalLinkClass}>
            {OAIC_CONTACT.name}
          </a>{' '}
          on {OAIC_CONTACT.phone}. If the organisation is a state or territory government
          body, the privacy regulator in that state or territory may be the right place
          instead.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact us">
        <ul className="space-y-2">
          <li>
            Privacy contact:{' '}
            <ContactValue value={PLATFORM_CONTACT.privacyEmail} kind="email" />
          </li>
          <li>
            For a question about a specific record, contact the organisation that holds
            it. You can{' '}
            <Link href="/organisations" className={legalLinkClass}>
              find an organisation
            </Link>
            .
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="changes" title="Changes to this policy">
        <p>
          We will update this policy when our practices change and show the date it was
          last updated at the top of this page. Each organisation’s collection notice is
          versioned so it is always clear which wording you were shown.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
