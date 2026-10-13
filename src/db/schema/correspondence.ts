import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  timestamps,
} from './_helpers';
import { correspondenceChannel, correspondenceKind, correspondenceStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { applications } from './applications';
import { decisions } from './decisions';
import { evidenceRequests } from './evidence';
import { certificates } from './certificates';

/**
 * Correspondence tables.
 *
 * An organisation writes its own templates. Staff preview a letter on a case,
 * then explicitly Send it. Nothing here sends an outcome because a decision
 * was finalised. The software never determines Aboriginality; a letter only
 * repeats what authorised people recorded.
 *
 * The bearer link for the applicant is stored as a SHA-256 hash. The rendered
 * letter kept on the case uses a placeholder instead of that link. The email
 * copy stored on the case is the short notice, not the letter detail.
 */

export const correspondenceTemplates = pgTable(
  'correspondence_templates',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    kind: correspondenceKind('kind').notNull(),
    subjectTemplate: text('subject_template').notNull(),
    bodyTemplate: text('body_template').notNull(),
    active: boolean('active').notNull().default(true),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('correspondence_templates_org_name_uidx').on(
      table.organisationId,
      table.name,
    ),
    index('correspondence_templates_org_kind_idx').on(table.organisationId, table.kind),
  ],
);

/**
 * One outbound letter or email on an application. A row is created as a draft
 * when staff prepare it, and becomes `sent` only when a person Sends it.
 */
export const correspondenceItems = pgTable(
  'correspondence_items',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    templateId: refId('template_id').references(() => correspondenceTemplates.id, {
      onDelete: 'set null',
    }),
    kind: correspondenceKind('kind').notNull(),
    channel: correspondenceChannel('channel').notNull(),
    status: correspondenceStatus('status').notNull().default('draft'),
    /** Template snapshot, so a later template edit does not rewrite the case. */
    subjectTemplate: text('subject_template').notNull(),
    bodyTemplate: text('body_template').notNull(),
    /** Letter text as sent. Null while still a draft. Portal link is redacted. */
    renderedSubject: text('rendered_subject'),
    renderedBody: text('rendered_body'),
    /** Short email actually queued. Null for printed letters. Link redacted. */
    emailSubject: text('email_subject'),
    emailText: text('email_text'),
    recipientName: text('recipient_name'),
    recipientEmail: text('recipient_email'),
    decisionId: refId('decision_id').references(() => decisions.id, {
      onDelete: 'set null',
    }),
    evidenceRequestId: refId('evidence_request_id').references(
      () => evidenceRequests.id,
      {
        onDelete: 'set null',
      },
    ),
    certificateId: refId('certificate_id').references(() => certificates.id, {
      onDelete: 'set null',
    }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** SHA-256 of the applicant link. The raw token is never stored. */
    portalTokenHash: text('portal_token_hash'),
    portalExpiresAt: timestamp('portal_expires_at', { withTimezone: true }),
    /** Object key of the printable PDF. Null for email, and until Send. */
    pdfObjectKey: text('pdf_object_key'),
    sentByUserId: refId('sent_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    index('correspondence_items_org_app_idx').on(
      table.organisationId,
      table.applicationId,
    ),
    uniqueIndex('correspondence_items_token_hash_uidx').on(table.portalTokenHash),
  ],
);

export const correspondenceTemplatesRelations = relations(
  correspondenceTemplates,
  ({ one, many }) => ({
    organisation: one(organisations, {
      fields: [correspondenceTemplates.organisationId],
      references: [organisations.id],
    }),
    createdBy: one(users, {
      fields: [correspondenceTemplates.createdByUserId],
      references: [users.id],
    }),
    items: many(correspondenceItems),
  }),
);

export const correspondenceItemsRelations = relations(correspondenceItems, ({ one }) => ({
  organisation: one(organisations, {
    fields: [correspondenceItems.organisationId],
    references: [organisations.id],
  }),
  application: one(applications, {
    fields: [correspondenceItems.applicationId],
    references: [applications.id],
  }),
  template: one(correspondenceTemplates, {
    fields: [correspondenceItems.templateId],
    references: [correspondenceTemplates.id],
  }),
  decision: one(decisions, {
    fields: [correspondenceItems.decisionId],
    references: [decisions.id],
  }),
  evidenceRequest: one(evidenceRequests, {
    fields: [correspondenceItems.evidenceRequestId],
    references: [evidenceRequests.id],
  }),
  certificate: one(certificates, {
    fields: [correspondenceItems.certificateId],
    references: [certificates.id],
  }),
}));
