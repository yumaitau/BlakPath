import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  rowVersion,
  timestamps,
} from './_helpers';
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
     * Idle timeout for staff sessions in this organisation, in seconds.
     * Allowed range is 30–60 minutes. This only ends a session; it does not
     * score, rank, or decide identity.
     */
    staffIdleTimeoutSeconds: integer('staff_idle_timeout_seconds')
      .notNull()
      .default(45 * 60),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('organisation_settings_org_unique').on(table.organisationId),
    check(
      'organisation_settings_staff_idle_range',
      sql`${table.staffIdleTimeoutSeconds} BETWEEN 1800 AND 3600`,
    ),
  ],
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
 * Turning it on for a tenant also requires a row in `ai_governance_approvals`.
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

/**
 * Governance approval recorded when an organisation administrator turns on
 * `aiFeatures`. Append-only: disabling the flag does not delete the history.
 * External tool access stays closed unless both this record and the flag exist.
 */
export const aiGovernanceApprovals = pgTable(
  'ai_governance_approvals',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** Council minute, resolution or other approval identifier. */
    reference: text('reference').notNull(),
    /** What was approved, in the organisation's own words. */
    statement: text('statement').notNull(),
    approvedByUserId: refId('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** True only when the administrator passed a step-up check. */
    stepUpVerified: boolean('step_up_verified').notNull(),
    ...timestamps,
  },
  (table) => [index('ai_governance_approvals_org_idx').on(table.organisationId)],
);

export const organisationsRelations = relations(organisations, ({ one, many }) => ({
  settings: one(organisationSettings, {
    fields: [organisations.id],
    references: [organisationSettings.organisationId],
  }),
  domains: many(organisationDomains),
  featureFlags: many(featureFlags),
  aiGovernanceApprovals: many(aiGovernanceApprovals),
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

export const aiGovernanceApprovalsRelations = relations(
  aiGovernanceApprovals,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [aiGovernanceApprovals.organisationId],
      references: [organisations.id],
    }),
    approvedBy: one(users, {
      fields: [aiGovernanceApprovals.approvedByUserId],
      references: [users.id],
    }),
  }),
);
