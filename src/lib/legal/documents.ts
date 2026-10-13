/**
 * Platform legal documents — status and contact details.
 *
 * The privacy policy, terms of use, accessibility statement and the default
 * collection-notice template are DRAFTS PENDING COUNSEL REVIEW. Every page that
 * shows them renders a visible draft banner while `counselApproved` is false.
 * Flip it only after counsel signs off, and fill the contact placeholders with
 * the operating entity's real details at the same time (see
 * docs/legal-review.md).
 */
export const LEGAL_DOCUMENT_STATUS = {
  counselApproved: false,
  /** Date the current draft text was last changed (shown on each page). */
  lastUpdated: '14 October 2026',
} as const;

/**
 * Platform operator contact details. `null` renders as "to be confirmed" — the
 * operating entity has not yet been named. Do not invent addresses here.
 */
export const PLATFORM_CONTACT: {
  operatorName: string | null;
  privacyEmail: string | null;
  supportEmail: string | null;
  accessibilityEmail: string | null;
} = {
  operatorName: null,
  privacyEmail: null,
  supportEmail: null,
  accessibilityEmail: null,
};

/** The Office of the Australian Information Commissioner (complaint escalation). */
export const OAIC_CONTACT = {
  name: 'Office of the Australian Information Commissioner (OAIC)',
  url: 'https://www.oaic.gov.au/privacy/privacy-complaints',
  phone: '1300 363 992',
} as const;
