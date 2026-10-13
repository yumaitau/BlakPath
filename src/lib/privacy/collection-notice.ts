import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * APP 5 collection notices (pure).
 *
 * Every point where BlakPath collects personal information from a person — a
 * public form, applicant evidence upload, staff-led intake — shows the owning
 * organisation's collection notice and records an acknowledgement before the
 * information is accepted. The acknowledgement stores the notice VERSION and a
 * SHA-256 HASH of the exact wording shown, so the organisation can later prove
 * which text a person saw even if the wording has since changed.
 *
 * Wording comes from `organisation_settings.consent_wording` when the
 * organisation has configured it, otherwise from the platform default template
 * below. The default template is a DRAFT pending counsel review and is flagged
 * as such in the UI; it must not be relied on as settled legal text.
 *
 * Wording is plain text paragraphs only (no markup), rendered by React, so
 * tenant-authored text cannot inject HTML.
 */

/** Platform template version. Bump whenever the template text changes. */
export const DEFAULT_COLLECTION_NOTICE_VERSION = 'platform-draft-2026-10-14';

/** Contact details a person can use for privacy questions about their record. */
export interface CollectionNoticeContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** The resolved notice exactly as shown to a person (and as hashed). */
export interface CollectionNotice {
  version: string;
  /** SHA-256 hex of the canonical notice content. */
  hash: string;
  /** True while the wording is the platform template pending counsel review. */
  draft: boolean;
  organisationName: string;
  title: string;
  paragraphs: string[];
  contact: CollectionNoticeContact | null;
  privacyPolicyUrl: string | null;
}

/** What a client sends back to prove which notice it showed and acknowledged. */
export const collectionNoticeAcknowledgementSchema = z.object({
  version: z.string().trim().min(1).max(80),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CollectionNoticeAcknowledgement = z.infer<
  typeof collectionNoticeAcknowledgementSchema
>;

/** Where an acknowledgement was captured. Stable identifiers; do not rename. */
export const COLLECTION_NOTICE_CONTEXTS = [
  'form_response',
  'evidence_upload',
  'application_intake',
] as const;
export type CollectionNoticeContext = (typeof COLLECTION_NOTICE_CONTEXTS)[number];

/**
 * How an acknowledgement was given: by the person themselves, or attested by a
 * staff member who gave the notice to the person during a staff-led intake.
 */
export type CollectionNoticeMethod = 'self' | 'staff_attested';

const contactSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.email().max(320).optional(),
  phone: z.string().trim().min(1).max(50).optional(),
});

/**
 * Organisation-authored notice configuration stored in
 * `organisation_settings.consent_wording`. `paragraphs` replaces the platform
 * template entirely; without it the template is used with the organisation's
 * own contact details and policy link.
 */
export const consentWordingSchema = z.object({
  version: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  paragraphs: z.array(z.string().trim().min(1).max(4000)).min(1).max(30).optional(),
  contact: contactSchema.optional(),
  privacyPolicyUrl: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .optional(),
});
export type ConsentWording = z.infer<typeof consentWordingSchema>;

/** Parse stored JSONB; invalid or absent config falls back to the template. */
export function parseConsentWording(value: unknown): ConsentWording | null {
  if (value === null || value === undefined) return null;
  const parsed = consentWordingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * DRAFT platform template — pending counsel review. Covers the APP 5.2 matters
 * in plain English. Counsel to confirm in particular: the overseas-disclosure
 * statement once the sub-processor register is final, and whether any
 * collection is required or authorised by a specific law for a given tenant.
 */
export function defaultCollectionNoticeParagraphs(organisationName: string): string[] {
  return [
    `${organisationName} is collecting this information. ${organisationName} is responsible for it and decides how your request is handled. BlakPath is the software ${organisationName} uses to keep its records.`,
    `${organisationName} collects this information to consider and keep a record of your request, to contact you about it, and to keep the records it needs to keep. Some of it may be sensitive, such as information about your Aboriginal or Torres Strait Islander identity, community connections and family history. It may include information about other people, such as family members.`,
    `You do not have to provide this information. If you do not, ${organisationName} may not be able to progress your request.`,
    `Only people authorised by ${organisationName} can see your information, such as its staff and the committee or panel that considers requests. ${organisationName} may also share it where you agree or where the law requires or allows it. BlakPath and the service providers that host it store the information for ${organisationName} in Australia and do not use it for their own purposes.`,
    'Decisions about your request are made by people. BlakPath does not make automated decisions, and it never scores, ranks, predicts or decides anyone’s Aboriginality.',
    `You can ask ${organisationName} to see or correct the information it holds about you, or make a privacy complaint, using the contact details below. If you are not satisfied with the response, you can contact the Office of the Australian Information Commissioner (oaic.gov.au). The BlakPath privacy policy explains more.`,
  ];
}

function normaliseContact(
  contact: ConsentWording['contact'],
): CollectionNoticeContact | null {
  if (!contact) return null;
  const resolved = {
    name: contact.name ?? null,
    email: contact.email ?? null,
    phone: contact.phone ?? null,
  };
  return resolved.name || resolved.email || resolved.phone ? resolved : null;
}

/**
 * SHA-256 over a canonical serialisation of everything the person sees. Keys
 * are listed explicitly so the order (and therefore the hash) is stable.
 */
export function hashCollectionNotice(notice: Omit<CollectionNotice, 'hash'>): string {
  const canonical = JSON.stringify([
    'blakpath-collection-notice/v1',
    notice.version,
    notice.draft,
    notice.organisationName,
    notice.title,
    notice.paragraphs,
    notice.contact
      ? [notice.contact.name, notice.contact.email, notice.contact.phone]
      : null,
    notice.privacyPolicyUrl,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Resolve the notice an organisation shows at the point of collection. */
export function resolveCollectionNotice(input: {
  organisationName: string;
  consentWording: unknown;
}): CollectionNotice {
  const wording = parseConsentWording(input.consentWording);
  const custom = wording?.paragraphs !== undefined;
  const base: Omit<CollectionNotice, 'hash'> = {
    version: custom
      ? (wording?.version ?? 'organisation')
      : DEFAULT_COLLECTION_NOTICE_VERSION,
    draft: !custom,
    organisationName: input.organisationName,
    title: wording?.title ?? 'How your information is collected and used',
    paragraphs: custom
      ? (wording?.paragraphs ?? [])
      : defaultCollectionNoticeParagraphs(input.organisationName),
    contact: normaliseContact(wording?.contact),
    privacyPolicyUrl: wording?.privacyPolicyUrl ?? null,
  };
  return { ...base, hash: hashCollectionNotice(base) };
}

/**
 * True only when the acknowledgement names the CURRENT notice. A stale page
 * (wording changed after it loaded) or a missing/forged acknowledgement fails.
 */
export function acknowledgementMatches(notice: CollectionNotice, raw: unknown): boolean {
  const parsed = collectionNoticeAcknowledgementSchema.safeParse(raw);
  if (!parsed.success) return false;
  return parsed.data.version === notice.version && parsed.data.hash === notice.hash;
}
