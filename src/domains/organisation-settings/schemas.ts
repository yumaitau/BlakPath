import { z } from 'zod';
import { parseDomain } from './dns';

/**
 * Organisation-authored configuration.
 *
 * These values configure wording and presentation. None of them is an input to
 * a determination: BlakPath never scores, ranks, predicts or decides
 * Aboriginality from settings.
 */

// The readiness checklist lives on the same row but is owned by onboarding
// (`/api/organisation/readiness`), which keeps its versioned shape.
export const SETTINGS_FIELDS = [
  'terminology',
  'branding',
  'publicGuidance',
  'eligibilityGuidance',
  'evidenceRequirements',
  'consentWording',
  'retentionDefaults',
  'escalationContacts',
] as const;

export type SettingsField = (typeof SETTINGS_FIELDS)[number];

const terminologyKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,63}$/);

export const terminologySchema = z
  .record(terminologyKey, z.string().trim().min(1).max(200))
  .refine((value) => Object.keys(value).length <= 40, {
    message: 'At most 40 terms.',
  });
export type Terminology = z.infer<typeof terminologySchema>;

export const brandingSchema = z
  .object({
    primaryColor: z
      .string()
      .trim()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    logoRef: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export type Branding = z.infer<typeof brandingSchema>;

export const guidanceSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(8000),
  })
  .strict();
export type Guidance = z.infer<typeof guidanceSchema>;

const evidenceItemSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(1000).optional(),
    required: z.boolean().optional(),
  })
  .strict();

export const evidenceRequirementsSchema = z
  .object({
    intro: z.string().trim().min(1).max(2000).optional(),
    items: z.array(evidenceItemSchema).max(30),
  })
  .strict();
export type EvidenceRequirements = z.infer<typeof evidenceRequirementsSchema>;

export const consentWordingSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(8000),
    version: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export type ConsentWording = z.infer<typeof consentWordingSchema>;

const retentionDays = z.number().int().min(1).max(36500);

export const retentionDefaultsSchema = z
  .object({
    applicationDays: retentionDays.optional(),
    evidenceDays: retentionDays.optional(),
    decisionDays: retentionDays.optional(),
    certificateDays: retentionDays.optional(),
  })
  .strict();
export type RetentionDefaults = z.infer<typeof retentionDefaultsSchema>;

const escalationContactSchema = z
  .object({
    role: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(200).optional(),
    email: z.email().max(320).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+().\-\s]{3,40}$/)
      .optional(),
  })
  .strict()
  .refine((contact) => Boolean(contact.name || contact.email || contact.phone), {
    message: 'Add a name, email or phone.',
  });

export const escalationContactsSchema = z
  .object({
    contacts: z.array(escalationContactSchema).max(10),
  })
  .strict();
export type EscalationContacts = z.infer<typeof escalationContactsSchema>;

export const fieldSchemas = {
  terminology: terminologySchema,
  branding: brandingSchema,
  publicGuidance: guidanceSchema,
  eligibilityGuidance: guidanceSchema,
  evidenceRequirements: evidenceRequirementsSchema,
  consentWording: consentWordingSchema,
  retentionDefaults: retentionDefaultsSchema,
  escalationContacts: escalationContactsSchema,
} as const;

export const updateSettingsSchema = z
  .object({
    field: z.enum(SETTINGS_FIELDS),
    value: z.unknown().nullable(),
  })
  .strict();

export const addDomainSchema = z.object({
  domain: z.string().transform((raw, ctx) => {
    const parsed = parseDomain(raw);
    if (!parsed.ok) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter a domain like council.example.gov.au',
      });
      return z.NEVER;
    }
    return parsed.domain;
  }),
});

export interface OrganisationSettingsView {
  terminology: Terminology | null;
  branding: Branding | null;
  publicGuidance: Guidance | null;
  eligibilityGuidance: Guidance | null;
  evidenceRequirements: EvidenceRequirements | null;
  consentWording: ConsentWording | null;
  retentionDefaults: RetentionDefaults | null;
  escalationContacts: EscalationContacts | null;
}

/** Parse one stored or submitted field. `null` clears it. */
export function parseFieldValue(field: SettingsField, value: unknown): unknown {
  if (value === null) return null;
  return fieldSchemas[field].parse(value);
}
