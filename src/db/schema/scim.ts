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
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * Per-organisation SCIM bearer credentials.
 *
 * The raw token is shown once at creation or rotation. Only its SHA-256 hash is
 * stored. The organisation is taken from the matching credential row — a path
 * segment that names a different organisation is rejected. `allowOrganisationAdmin`
 * is an explicit tenant opt-in; without it the credential cannot assign that role.
 */
export const scimCredentials = pgTable(
  'scim_credentials',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    /** SHA-256 hex of the bearer token. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** Non-secret display prefix, e.g. "scim_ab12cd". */
    prefix: text('prefix').notNull(),
    /**
     * When false (the default), this credential cannot grant `organisation-admin`.
     * A tenant opts in by setting this on the credential it issues.
     */
    allowOrganisationAdmin: boolean('allow_organisation_admin').notNull().default(false),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('scim_credentials_token_hash_unique').on(table.tokenHash),
    index('scim_credentials_org_idx').on(table.organisationId),
  ],
);

export const scimCredentialsRelations = relations(scimCredentials, ({ one }) => ({
  organisation: one(organisations, {
    fields: [scimCredentials.organisationId],
    references: [organisations.id],
  }),
  createdBy: one(users, {
    fields: [scimCredentials.createdByUserId],
    references: [users.id],
  }),
}));
