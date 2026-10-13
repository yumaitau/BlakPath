import { relations } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { primaryId, refId, rowVersion, timestamps } from './_helpers';
import { organisationStatus } from './enums';

/**
 * Tenancy tables.
 *
 * An `organisation` IS the tenant boundary, so it is NOT itself tenant-owned
 * (it carries no `organisation_id`). Every OTHER tenant-owned table across the
 * platform references `organisations.id` and leads its indexes with that
 * column. Tenant ids are never trusted from the browser — they are derived and
 * DB-verified in the tenancy context layer.
 */

/**
 * An authorised Aboriginal or Torres Strait Islander organisation that
 * administers Confirmation of Aboriginality applications on this platform.
 */
export const organisations = pgTable(
  'organisations',
  {
    id: primaryId(),
    legalName: text('legal_name').notNull(),
    tradingName: text('trading_name'),
    organisationType: text('organisation_type'),
    /** Australian Business Number, stored as given (no derived judgement). */
    abn: text('abn'),
    slug: text('slug').notNull(),
    status: organisationStatus('status').notNull().default('draft'),
    /** Data-residency region. Australian residency: ap-southeast-2. */
    region: text('region').notNull().default('ap-southeast-2'),
    /** Whether the public may start an application with this organisation. */
    publicApplicationsOpen: boolean('public_applications_open').notNull().default(false),
    /**
     * When true, staff of this organisation must enrol a passkey or authenticator
     * before any tenant route or staff screen (other than enrolment) will run.
     * Operator provisioning sets this. Existing tenants stay false until opted in.
     */
    staffMfaRequired: boolean('staff_mfa_required').notNull().default(false),
    ...timestamps,
    ...rowVersion,
  },
  (table) => [uniqueIndex('organisations_slug_unique').on(table.slug)],
);

/**
 * Per-organisation configuration.
 *
 * JSONB is used ONLY for genuinely flexible, organisation-authored config
 * (terminology, guidance wording, evidence requirements, etc.). It is never
 * used for relational data that other modules must query or join. None of
 * these settings can automate a determination — they configure guidance and
 * presentation only.
 */
export const organisationSettings = pgTable(
  'organisation_settings',
  {
    id: primaryId(),
    organisationId: refId('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Preferred terminology / labels shown to applicants and staff. */
    terminology: jsonb('terminology'),
    /** Branding tokens (logo refs, colours) for tenant theming. */
    branding: jsonb('branding'),
    /** Public-facing guidance content shown before applying. */
    publicGuidance: jsonb('public_guidance'),
    /** Plain-English eligibility guidance (informational, non-determinative). */
    eligibilityGuidance: jsonb('eligibility_guidance'),
    /** What evidence the organisation asks applicants to provide. */
    evidenceRequirements: jsonb('evidence_requirements'),
    /** Consent wording presented to applicants. */
    consentWording: jsonb('consent_wording'),
    /** Default data-retention periods for tenant records. */
    retentionDefaults: jsonb('retention_defaults'),
    /** Escalation / safeguarding contacts. */
    escalationContacts: jsonb('escalation_contacts'),
    /** Onboarding readiness checklist state. */
    readinessChecklist: jsonb('readiness_checklist'),
    /**
     * Identifier of the signed services agreement. Together with
     * `agreementSignedAt` this is a human attestation that counsel's agreement
     * is signed. The document itself is not stored here.
     */
    agreementReference: text('agreement_reference'),
    agreementSignedAt: timestamp('agreement_signed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('organisation_settings_org_unique').on(table.organisationId)],
);

/** A DNS domain claimed by an organisation (for email-domain-based routing). */
export const organisationDomains = pgTable(
  'organisation_domains',
  {
    id: primaryId(),
    organisationId: refId('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    verified: boolean('verified').notNull().default(false),
    /** Single-use token proving control of the domain. */
    verificationToken: text('verification_token'),
    ...timestamps,
  },
  (table) => [uniqueIndex('organisation_domains_domain_unique').on(table.domain)],
);

/**
 * Feature flags. A null `organisationId` is the platform default for that key;
 * an organisation-scoped row overrides it for that tenant.
 *
 * `aiFeatures` defaults to false and MUST stay off unless a human explicitly
 * enables it — no AI capability may ever score, rank, or infer Aboriginality.
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: primaryId(),
    /** Null = platform-wide default; set = tenant override. */
    organisationId: refId('organisation_id').references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    key: text('key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    // NOTE: null organisation_id rows collide under a single unique index in
    // Postgres only when non-null; platform defaults (null) are enforced unique
    // per-key at the application layer. Tenant overrides are unique per (org,key).
    uniqueIndex('feature_flags_org_key_unique').on(table.organisationId, table.key),
  ],
);

export const organisationsRelations = relations(organisations, ({ one, many }) => ({
  settings: one(organisationSettings, {
    fields: [organisations.id],
    references: [organisationSettings.organisationId],
  }),
  domains: many(organisationDomains),
  featureFlags: many(featureFlags),
}));

export const organisationSettingsRelations = relations(
  organisationSettings,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [organisationSettings.organisationId],
      references: [organisations.id],
    }),
  }),
);

export const organisationDomainsRelations = relations(organisationDomains, ({ one }) => ({
  organisation: one(organisations, {
    fields: [organisationDomains.organisationId],
    references: [organisations.id],
  }),
}));

export const featureFlagsRelations = relations(featureFlags, ({ one }) => ({
  organisation: one(organisations, {
    fields: [featureFlags.organisationId],
    references: [organisations.id],
  }),
}));
