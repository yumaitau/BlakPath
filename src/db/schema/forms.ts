import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  rowVersion,
  softDelete,
  timestamps,
} from './_helpers';
import { formInvitationStatus, formStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { applications } from './applications';

/**
 * Custom form tables.
 *
 * A form is a set of author-defined questions (`fields` JSONB, validated by
 * src/lib/forms/fields.ts). Staff send a per-recipient tokenised invitation; the
 * recipient completes the form via a public link WITHOUT signing in, and the
 * answers land in `form_responses`. All tenant-owned and org-leading indexed.
 *
 * SECURITY: an invitation stores the SHA-256 HASH of its secret token for
 * lookup, plus a sealed copy used only to deliver the email. The seal is
 * envelope ciphertext and is cleared after a successful send. A database read
 * never yields a usable link. The public completion path resolves a presented
 * token by hashing it and matching the hash — the token itself is the
 * capability, and it is scoped, single-use and expiring.
 */
export const forms = pgTable(
  'forms',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    description: text('description'),
    /** Author-defined field definitions (see src/lib/forms/fields.ts). */
    fields: jsonb('fields').notNull().default([]),
    status: formStatus('status').notNull().default('draft'),
    /** Optional link to the application this form gathers information for. */
    applicationId: refId('application_id').references(() => applications.id, {
      onDelete: 'set null',
    }),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
    ...rowVersion,
    ...softDelete,
  },
  (table) => [index('forms_org_status_idx').on(table.organisationId, table.status)],
);

/** A tokenised, per-recipient invitation to complete a form. */
export const formInvitations = pgTable(
  'form_invitations',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    formId: refId('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the secret token. Lookup key; not a usable link. */
    tokenHash: text('token_hash').notNull(),
    /**
     * Envelope-encrypted bearer token. Present only until the worker sends
     * the invitation email, then cleared. Never copied onto a queue.
     */
    tokenSeal: jsonb('token_seal'),
    recipientName: text('recipient_name'),
    recipientEmail: text('recipient_email'),
    status: formInvitationStatus('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    sentByUserId: refId('sent_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('form_invitations_token_hash_unique').on(table.tokenHash),
    index('form_invitations_org_form_idx').on(table.organisationId, table.formId),
  ],
);

/** A submitted response to a form. */
export const formResponses = pgTable(
  'form_responses',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    formId: refId('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    invitationId: refId('invitation_id').references(() => formInvitations.id, {
      onDelete: 'set null',
    }),
    /** The validated answer set, keyed by field key. */
    answers: jsonb('answers').notNull(),
    respondentName: text('respondent_name'),
    respondentEmail: text('respondent_email'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Coarse origin for abuse investigation; not shown in the UI. */
    ipAddress: text('ip_address'),
    ...timestamps,
  },
  (table) => [
    index('form_responses_org_form_idx').on(table.organisationId, table.formId),
  ],
);

export const formsRelations = relations(forms, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [forms.organisationId],
    references: [organisations.id],
  }),
  application: one(applications, {
    fields: [forms.applicationId],
    references: [applications.id],
  }),
  createdBy: one(users, {
    fields: [forms.createdByUserId],
    references: [users.id],
  }),
  invitations: many(formInvitations),
  responses: many(formResponses),
}));

export const formInvitationsRelations = relations(formInvitations, ({ one }) => ({
  organisation: one(organisations, {
    fields: [formInvitations.organisationId],
    references: [organisations.id],
  }),
  form: one(forms, {
    fields: [formInvitations.formId],
    references: [forms.id],
  }),
  sentBy: one(users, {
    fields: [formInvitations.sentByUserId],
    references: [users.id],
  }),
}));

export const formResponsesRelations = relations(formResponses, ({ one }) => ({
  organisation: one(organisations, {
    fields: [formResponses.organisationId],
    references: [organisations.id],
  }),
  form: one(forms, {
    fields: [formResponses.formId],
    references: [forms.id],
  }),
  invitation: one(formInvitations, {
    fields: [formResponses.invitationId],
    references: [formInvitations.id],
  }),
}));
