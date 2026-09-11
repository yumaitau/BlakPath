import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { primaryId, timestamps } from './_helpers';

/**
 * Email suppressions from SES bounce/complaint events.
 *
 * SNS delivers bounce/complaint notifications to POST /api/email/events.
 * Suppressed addresses are never emailed again until explicitly cleared.
 * Global scope (no organisation_id): a bounced address stays suppressed
 * platform-wide. Stores only the address hash + kind, never message content.
 */
export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    id: primaryId(),
    /** Lower-cased SHA-256 hex of the recipient address (no plaintext PII). */
    addressHash: text('address_hash').notNull(),
    /** bounce | complaint. */
    kind: text('kind').notNull().default('bounce'),
    /** SES message id that triggered suppression, if any. */
    sourceMessageId: text('source_message_id'),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('email_suppressions_hash_idx').on(table.addressHash)],
);

export const emailSuppressionsRelations = relations(emailSuppressions, () => ({}));
