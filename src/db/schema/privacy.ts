import { relations } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  timestamps,
} from './_helpers';
import { rightsRequestStatus, rightsRequestType, tenantOffboardingStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { clients } from './teams';

/**
 * Individual-rights tables.
 *
 * A rights request is a person's request to the organisation — access to their
 * records (APP 12), correction (APP 13), a complaint, withdrawal of consent or
 * erasure — tracked to a statutory due date. An associated statement is the
 * person's own statement attached to a record the organisation declined to
 * correct (APP 13.4); it travels with that record whenever it is disclosed.
 *
 * Both are tenant-owned and org-leading indexed. Handling a request is always a
 * recorded human act; nothing here decides anything about a person.
 */
export const rightsRequests = pgTable(
  'rights_requests',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    type: rightsRequestType('type').notNull(),
    status: rightsRequestStatus('status').notNull().default('received'),
    /** The client record the request is about (council tenant model). */
    subjectClientId: refId('subject_client_id').references(() => clients.id, {
      onDelete: 'set null',
    }),
    /** The account the request is about, when the person has one. */
    subjectUserId: refId('subject_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Who made the request (the person, or someone acting for them). */
    requesterName: text('requester_name').notNull(),
    requesterContact: text('requester_contact'),
    /** What was asked for, in the requester's terms. */
    details: text('details'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Statutory response date; moves only with a recorded extension reason. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    extensionReason: text('extension_reason'),
    assignedToUserId: refId('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    loggedByUserId: refId('logged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The organisation's recorded response, including reasons for a refusal. */
    outcome: text('outcome'),
    /** When the worker last ran an erasure for this request. */
    erasedAt: timestamp('erased_at', { withTimezone: true }),
    /** That run's report: per-table row counts and ids only, no content. */
    erasureReport: jsonb('erasure_report'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('rights_requests_org_status_due_idx').on(
      table.organisationId,
      table.status,
      table.dueAt,
    ),
    index('rights_requests_org_client_idx').on(
      table.organisationId,
      table.subjectClientId,
    ),
    index('rights_requests_org_user_idx').on(table.organisationId, table.subjectUserId),
  ],
);

/** A person's statement associated with a record the organisation did not correct. */
export const associatedStatements = pgTable(
  'associated_statements',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    requestId: refId('request_id')
      .notNull()
      .references(() => rightsRequests.id, { onDelete: 'cascade' }),
    /** The table the statement is attached to, e.g. 'applications'. */
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    /** The field the person says is wrong, when they named one. */
    field: text('field'),
    statement: text('statement').notNull(),
    recordedByUserId: refId('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    index('associated_statements_org_resource_idx').on(
      table.organisationId,
      table.resourceType,
      table.resourceId,
    ),
  ],
);

/**
 * A tenant offboarding: export everything, then — only after a human confirms
 * the export was received — purge the tenant's database rows and objects.
 *
 * Deliberately NOT foreign-keyed to `organisations`: this row is the platform's
 * record that the tenant was exported and purged, so it must survive the purge
 * it describes. It holds no personal information (the manifest is per-table
 * row counts only).
 */
export const tenantOffboardings = pgTable(
  'tenant_offboardings',
  {
    id: primaryId(),
    organisationId: uuid('organisation_id').notNull(),
    /** Kept so operators can identify the tenant after its row is gone. */
    organisationSlug: text('organisation_slug').notNull(),
    status: tenantOffboardingStatus('status').notNull().default('export_queued'),
    requestedByUserId: refId('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    exportObjectKey: text('export_object_key'),
    exportSha256: text('export_sha256'),
    exportRowCount: bigint('export_row_count', { mode: 'number' }),
    /** Per-table row counts in the export (no row content). */
    manifest: jsonb('manifest'),
    exportedAt: timestamp('exported_at', { withTimezone: true }),
    downloadedAt: timestamp('downloaded_at', { withTimezone: true }),
    purgeConfirmedByUserId: refId('purge_confirmed_by_user_id').references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    purgeConfirmedAt: timestamp('purge_confirmed_at', { withTimezone: true }),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    error: text('error'),
    ...timestamps,
  },
  (table) => [index('tenant_offboardings_org_idx').on(table.organisationId)],
);

export const rightsRequestsRelations = relations(rightsRequests, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [rightsRequests.organisationId],
    references: [organisations.id],
  }),
  subjectClient: one(clients, {
    fields: [rightsRequests.subjectClientId],
    references: [clients.id],
  }),
  subjectUser: one(users, {
    fields: [rightsRequests.subjectUserId],
    references: [users.id],
  }),
  statements: many(associatedStatements),
}));

export const associatedStatementsRelations = relations(
  associatedStatements,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [associatedStatements.organisationId],
      references: [organisations.id],
    }),
    request: one(rightsRequests, {
      fields: [associatedStatements.requestId],
      references: [rightsRequests.id],
    }),
  }),
);
