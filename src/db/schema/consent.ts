import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  timestamps,
} from './_helpers';
import { users } from './auth';
import { clients } from './teams';
import { organisations } from './tenancy';

/**
 * LEGACY (v1) consent records — superseded by `consent_events` below and no
 * longer written by any service. Kept only so existing rows are not destroyed
 * by a migration; a follow-up may archive and drop it.
 *
 * A consent record captures a person's agreement (or withdrawal) for a stated
 * purpose: representative access, evidence handling, communications. Time-boxed
 * via `expiresAt`, revocable via `revokedAt`. `representative_authorisations`
 * links here through `consentRecordId`. Nothing is inferred; every grant is an
 * explicit recorded act, permission-checked and audited.
 */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** Person the consent is about. */
    subjectUserId: refId('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who recorded it (staff intake or the subject themselves). */
    recordedByUserId: refId('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Purpose key, e.g. 'representative-access', 'evidence-handling'. */
    purpose: text('purpose').notNull(),
    /** granted | withdrawn (app-checked). */
    status: text('status').notNull().default('granted'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps,
  },
  (table) => [
    index('consent_org_subject_idx').on(table.organisationId, table.subjectUserId),
    index('consent_org_purpose_idx').on(table.organisationId, table.purpose),
  ],
);

export const consentRecordsRelations = relations(consentRecords, ({ one }) => ({
  organisation: one(organisations, {
    fields: [consentRecords.organisationId],
    references: [organisations.id],
  }),
  subject: one(users, {
    fields: [consentRecords.subjectUserId],
    references: [users.id],
  }),
  recordedBy: one(users, {
    fields: [consentRecords.recordedByUserId],
    references: [users.id],
  }),
}));

/**
 * Consent wording versions — the exact text a person was shown.
 *
 * Tenant-authored, one monotonically increasing `version` per purpose.
 * IMMUTABLE once published: a database trigger rejects UPDATE/DELETE, so a
 * grant that references a version can always reproduce the words consented to.
 * Changing the wording means publishing a new version. `bodySha256` lets a
 * printed or signed copy be matched to the stored text.
 */
export const consentWordingVersions = pgTable(
  'consent_wording_versions',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'restrict',
    }),
    /** Purpose key the wording covers (see domains/consent/rules.ts). */
    purpose: text('purpose').notNull(),
    version: integer('version').notNull(),
    locale: text('locale').notNull().default('en-AU'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    bodySha256: text('body_sha256').notNull(),
    /** Plain uuid (no FK), like audit actors: account erasure never rewrites it. */
    publishedByUserId: refId('published_by_user_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('consent_wording_org_purpose_version_unique').on(
      table.organisationId,
      table.purpose,
      table.version,
    ),
  ],
);

/**
 * Consent ledger (v2) — APPEND-ONLY.
 *
 * One row per recorded human act: a `granted` event, or a `withdrawn` event
 * that points at the grant it ends (`grantEventId`). Rows are never updated or
 * deleted — a database trigger rejects UPDATE/DELETE/TRUNCATE — so current
 * state is always derived from history (domains/consent/rules.ts).
 *
 * The subject is a user account and/or a `clients` record, so consent can be
 * recorded for a person who has no login (paper or phone intake). Every grant
 * references the wording version shown, how consent was given (`method`) and
 * the evidence of it, and who gave it (the subject, a representative or a
 * guardian). Nothing here is inferred; every row is an explicit recorded act.
 */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'restrict',
    }),
    /** granted | withdrawn. */
    kind: text('kind').notNull(),
    /** For `withdrawn` events: the grant being withdrawn (one withdrawal max). */
    grantEventId: refId('grant_event_id').references(
      (): AnyPgColumn => consentEvents.id,
      { onDelete: 'restrict' },
    ),
    /** Subject's account, when they have one (plain uuid, like audit actors). */
    subjectUserId: refId('subject_user_id'),
    /** Subject's client record — present for people without an account. */
    subjectClientId: refId('subject_client_id').references(() => clients.id, {
      onDelete: 'restrict',
    }),
    /** Purpose key (closed list, app-checked). */
    purpose: text('purpose').notNull(),
    /** Wording shown; required on grants. */
    wordingVersionId: refId('wording_version_id').references(
      () => consentWordingVersions.id,
      { onDelete: 'restrict' },
    ),
    /** Receiving organisation, for inter-organisation sharing grants. */
    sharingRecipient: text('sharing_recipient'),
    /** signed-form | verbal-witnessed | online-acknowledgement | written-request. */
    method: text('method').notNull(),
    /** Reference to the signed form / written request (document id, file ref). */
    evidenceReference: text('evidence_reference'),
    /** Witness to verbal consent or withdrawal. */
    witnessName: text('witness_name'),
    /** subject | representative | guardian. */
    givenBy: text('given_by').notNull().default('subject'),
    representativeName: text('representative_name'),
    representativeRelationship: text('representative_relationship'),
    representativeUserId: refId('representative_user_id'),
    /** staff | self-service — the channel the act was recorded through. */
    channel: text('channel').notNull(),
    /** Who recorded the event. */
    actorUserId: refId('actor_user_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    notes: text('notes'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('consent_events_org_subject_user_idx').on(
      table.organisationId,
      table.subjectUserId,
    ),
    index('consent_events_org_subject_client_idx').on(
      table.organisationId,
      table.subjectClientId,
    ),
    index('consent_events_org_purpose_idx').on(table.organisationId, table.purpose),
    uniqueIndex('consent_events_grant_event_unique').on(table.grantEventId),
    check(
      'consent_events_subject_present',
      sql`${table.subjectUserId} IS NOT NULL OR ${table.subjectClientId} IS NOT NULL`,
    ),
    check(
      'consent_events_shape',
      sql`(${table.kind} = 'granted' AND ${table.wordingVersionId} IS NOT NULL AND ${table.grantEventId} IS NULL)
        OR (${table.kind} = 'withdrawn' AND ${table.grantEventId} IS NOT NULL)`,
    ),
  ],
);

export const consentWordingVersionsRelations = relations(
  consentWordingVersions,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [consentWordingVersions.organisationId],
      references: [organisations.id],
    }),
  }),
);

export const consentEventsRelations = relations(consentEvents, ({ one }) => ({
  organisation: one(organisations, {
    fields: [consentEvents.organisationId],
    references: [organisations.id],
  }),
  subjectClient: one(clients, {
    fields: [consentEvents.subjectClientId],
    references: [clients.id],
  }),
  wordingVersion: one(consentWordingVersions, {
    fields: [consentEvents.wordingVersionId],
    references: [consentWordingVersions.id],
  }),
}));
