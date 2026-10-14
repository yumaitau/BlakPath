import { relations } from 'drizzle-orm';
import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { organisationId as organisationIdCol, primaryId, timestamps } from './_helpers';
import { organisations } from './tenancy';

/**
 * Outbound tenant email stored so the queue payload can stay an id.
 *
 * Recipient, subject and bodies are sealed under the tenant key. This is the
 * encrypted holding place for those bodies, not a correspondence product.
 */
export const correspondenceMessages = pgTable(
  'correspondence_messages',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    recipient: text('recipient').notNull(),
    subject: text('subject').notNull(),
    textBody: text('text_body').notNull(),
    htmlBody: text('html_body'),
    ...timestamps,
  },
  (table) => [index('correspondence_messages_org_idx').on(table.organisationId)],
);

export const correspondenceMessagesRelations = relations(
  correspondenceMessages,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [correspondenceMessages.organisationId],
      references: [organisations.id],
    }),
  }),
);
