import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ContactValue,
  LegalPage,
  LegalSection,
  legalLinkClass,
} from '@/components/legal/legal-page';
import { PLATFORM_CONTACT } from '@/lib/legal/documents';

export const metadata: Metadata = { title: 'Terms of use' };

/**
 * Terms of use — DRAFT PENDING COUNSEL REVIEW.
 *
 * Plain-English terms for people using the BlakPath website and app. The
 * contract between the operator and each organisation is a separate agreement.
 * Governing law, liability wording and the operator entity are open questions
 * for counsel (docs/legal-review.md).
 */
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      intro={
        <p>
          These terms apply when you use the BlakPath website or app, whether you work for
          an organisation that uses BlakPath, are applying to one, are completing a form
          you were sent, or are checking a certificate. Please read them with the{' '}
          <Link href="/privacy" className={legalLinkClass}>
            privacy policy
          </Link>
          .
        </p>
      }
    >
      <LegalSection id="about" title="About BlakPath">
        <p>
          BlakPath is software provided by the platform operator (
          <ContactValue value={PLATFORM_CONTACT.operatorName} />) to authorised Aboriginal
          and Torres Strait Islander organisations. Each organisation runs its own process
          and makes its own decisions. BlakPath records that work; it never decides,
          scores or infers anyone’s Aboriginality.
        </p>
        <p>
          If you are applying to an organisation, your dealings about your application are
          with that organisation, under its own process and policies.
        </p>
      </LegalSection>

      <LegalSection id="accounts" title="Accounts and access">
        <ul className="list-disc space-y-2 pl-5">
          <li>Keep your sign-in details and authentication devices secure.</li>
          <li>
            Use only the access an organisation has given you, and only for its work.
          </li>
          <li>
            Form and invitation links are personal. Do not share them with anyone else.
          </li>
          <li>Tell the organisation promptly if you think your account is misused.</li>
        </ul>
      </LegalSection>

      <LegalSection id="acceptable-use" title="Acceptable use">
        <p>You must not:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>provide information you know is false or misleading;</li>
          <li>
            upload material you do not have the right to share, or that contains malware;
          </li>
          <li>
            try to access records, organisations or parts of the service you are not
            authorised to use, or test, probe or disrupt the service without written
            permission;
          </li>
          <li>
            use information from BlakPath for any purpose other than the organisation’s
            work, or to harass, discriminate against or harm anyone.
          </li>
        </ul>
        <p>
          Access can be suspended where it is needed to protect people, records or the
          service.
        </p>
      </LegalSection>

      <LegalSection id="information" title="Your information and content">
        <p>
          Information and documents you provide belong to you or the people who supplied
          them. You allow the organisation, and the operator on its behalf, to store and
          use them to provide the service and as described in the privacy policy and the
          organisation’s collection notice.
        </p>
        <p>
          Certificates and records are issued by the organisation, not by BlakPath. A
          certificate check shows only whether a certificate the organisation issued is
          valid.
        </p>
      </LegalSection>

      <LegalSection id="availability" title="Availability and changes">
        <p>
          We work to keep BlakPath available, secure and accurate, but it may sometimes be
          unavailable for maintenance or because of events outside our control. We may
          change the service and these terms; the date at the top of this page shows when
          they last changed.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="Consumer rights and liability">
        <p>
          Nothing in these terms excludes rights you have under the Australian Consumer
          Law or other laws that cannot be excluded. Subject to those rights, the
          operator’s liability is limited as set out in the final version of these terms.
        </p>
      </LegalSection>

      <LegalSection id="law" title="Governing law">
        <p>
          These terms are governed by the laws of the Australian state or territory to be
          confirmed in the final version.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Questions about these terms:{' '}
          <ContactValue value={PLATFORM_CONTACT.supportEmail} kind="email" />. For
          questions about an application, contact the organisation managing it.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
