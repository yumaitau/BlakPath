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
 * SECURITY: an invitation stores only the SHA-256 HASH of its secret token, so a
 * database read never yields a usable link. The public completion path resolves
 * a presented token by hashing it and matching the hash — the token itself is
 * the capability, and it is scoped, single-use for submission, and expiring.
 * A half-finished draft may be saved against that same token and resumed until
 * the invitation expires; submitting still consumes the token.
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
    /** SHA-256 hex of the secret token. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    recipientName: text('recipient_name'),
    recipientEmail: text('recipient_email'),
    status: formInvitationStatus('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    sentByUserId: refId('sent_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * Partial answers saved by the recipient so the same token can resume the
     * form. Cleared on submit. Never shown to anyone but that token holder.
     */
    draftAnswers: jsonb('draft_answers'),
    draftSavedAt: timestamp('draft_saved_at', { withTimezone: true }),
    /** Drafts are unreadable once this passes, even if the row remains. */
    draftExpiresAt: timestamp('draft_expires_at', { withTimezone: true }),
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
    /**
     * Case this response belongs to. Set when the form is already linked to a
     * case, or when staff create/attach a case afterwards. Null until then.
     */
    applicationId: refId('application_id').references(() => applications.id, {
      onDelete: 'set null',
    }),
    respondentName: text('respondent_name'),
    respondentEmail: text('respondent_email'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Coarse origin for abuse investigation; not shown in the UI. */
    ipAddress: text('ip_address'),
    ...timestamps,
  },
  (table) => [
    index('form_responses_org_form_idx').on(table.organisationId, table.formId),
    index('form_responses_org_application_idx').on(
      table.organisationId,
      table.applicationId,
    ),
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
  application: one(applications, {
    fields: [formResponses.applicationId],
    references: [applications.id],
  }),
}));
