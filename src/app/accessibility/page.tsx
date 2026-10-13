import type { Metadata } from 'next';

import {
  ContactValue,
  LegalPage,
  LegalSection,
  legalLinkClass,
} from '@/components/legal/legal-page';
import { LEGAL_DOCUMENT_STATUS, PLATFORM_CONTACT } from '@/lib/legal/documents';

export const metadata: Metadata = { title: 'Accessibility statement' };

/**
 * Accessibility statement — DRAFT PENDING REVIEW.
 *
 * Structure follows the W3C statement model: commitment, conformance status,
 * assessment approach, known limitations, feedback contact and escalation.
 * Conformance stays "partially conformant" until the independent audit and
 * assisted review (docs/accessibility-acceptance.md) are complete. Keep the
 * known-limitations list in step with the "Known exceptions" table there.
 */

const knownLimitations = [
  {
    title: 'Not yet independently audited',
    detail:
      'Automated checks and keyboard testing have not been confirmed by an independent WCAG 2.2 AA audit or by testing with people who use assistive technology.',
  },
  {
    title: 'Tested mainly in one browser engine',
    detail:
      'Automated checks run in Chromium. Some differences may exist in Safari, Firefox or mobile screen readers.',
  },
  {
    title: 'Certificate PDFs',
    detail:
      'Generated certificate PDFs may not be fully tagged for screen readers. The certificate check page gives the same information in an accessible web page.',
  },
  {
    title: 'Documents supplied by others',
    detail:
      'Evidence documents uploaded by applicants or organisations, such as scanned records, are shown as supplied and may not be accessible.',
  },
] as const;

export default function AccessibilityPage() {
  return (
    <LegalPage
      title="Accessibility statement"
      intro={
        <p>
          BlakPath is committed to being usable by everyone, including people who use a
          keyboard, screen reader, magnifier, voice control or other assistive technology.
          This statement applies to the BlakPath website and app.
        </p>
      }
    >
      <LegalSection id="conformance" title="Conformance status">
        <p>
          The target standard is the{' '}
          <a href="https://www.w3.org/TR/WCAG22/" className={legalLinkClass}>
            Web Content Accessibility Guidelines (WCAG) 2.2
          </a>{' '}
          at level AA. BlakPath is currently{' '}
          <strong className="text-foreground">partially conformant</strong>: some parts
          may not yet fully meet the standard, as listed under known limitations.
        </p>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
          <dt className="text-foreground font-medium">Standard</dt>
          <dd>WCAG 2.2 level AA</dd>
          <dt className="text-foreground font-medium">Status</dt>
          <dd>Partially conformant</dd>
          <dt className="text-foreground font-medium">Statement date</dt>
          <dd>{LEGAL_DOCUMENT_STATUS.lastUpdated}</dd>
          <dt className="text-foreground font-medium">Last assessed</dt>
          <dd>Independent assessment not yet completed</dd>
        </dl>
      </LegalSection>

      <LegalSection id="approach" title="How accessibility is checked">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Automated WCAG 2.2 AA checks run on the main public, staff and form journeys
            for every change.
          </li>
          <li>
            Keyboard-only checks cover navigation, menus, forms, the work board and error
            messages.
          </li>
          <li>
            Manual screen-reader testing, an independent audit and assisted usability
            sessions with representative users are planned before broad rollout.
          </li>
        </ul>
        <p>
          Design features include clear labels, visible keyboard focus, a skip link,
          responsive layouts, text alternatives for charts and status messages that screen
          readers announce.
        </p>
      </LegalSection>

      <LegalSection id="known-limitations" title="Known limitations">
        <ul className="space-y-4">
          {knownLimitations.map((item) => (
            <li key={item.title}>
              <p className="text-foreground font-medium">{item.title}</p>
              <p>{item.detail}</p>
            </li>
          ))}
        </ul>
      </LegalSection>

      <LegalSection id="feedback" title="Feedback and help">
        <p>
          If something is hard to use, ask the organisation you are working with for help
          or another way to complete the task. They can, for example, take your
          information by phone or in person.
        </p>
        <p>
          To report an accessibility problem with BlakPath itself, contact{' '}
          <ContactValue value={PLATFORM_CONTACT.accessibilityEmail} kind="email" />. Tell
          us the page, what you were trying to do and the technology you use. We aim to
          reply within 5 business days.
        </p>
      </LegalSection>

      <LegalSection id="escalation" title="If you are not satisfied">
        <p>
          If you are not happy with our response, you can contact the{' '}
          <a href="https://humanrights.gov.au/complaints" className={legalLinkClass}>
            Australian Human Rights Commission
          </a>
          , which handles complaints about disability discrimination.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
