import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { primaryId, timestamps } from './_helpers';

/**
 * Email suppressions from SES bounce/complaint events.
 *
 * SNS delivers permanent-bounce and complaint notifications to
 * POST /api/email/events. Transient bounces are not stored. Suppressed
 * addresses are not emailed again until a platform operator clears them.
 * Global scope (no organisation_id). Stores only the address hash + kind,
 * never message content.
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
    /**
     * Operator's free-text reason for clearing. Mutable, so it can be
     * corrected or erased. The audit trail stores `email.suppression_note` only.
     */
    clearedReason: text('cleared_reason'),
    ...timestamps,
  },
  (table) => [index('email_suppressions_hash_idx').on(table.addressHash)],
);

export const emailSuppressionsRelations = relations(emailSuppressions, () => ({}));
