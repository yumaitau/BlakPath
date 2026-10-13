import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  timestamps,
} from './_helpers';
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * API keys for the public REST API.
 *
 * A key authenticates an integrator as a specific organisation with a SCOPED
 * subset of permissions — never full tenant access implicitly. Only the SHA-256
 * hash of the secret is stored (mirroring `form_invitations`); the raw key is
 * shown to the creator exactly once. `prefix` is a non-secret display hint
 * (e.g. "bp_ab12cd") so a key can be recognised in a list without revealing it.
 *
 * SECURITY: the key is the capability. It carries only the permission keys in
 * `scopes`, and every call made with it is tenant-scoped and audited with the
 * key as the acting principal.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    /** SHA-256 hex of the secret key. The raw key is never stored. */
    keyHash: text('key_hash').notNull(),
    /** Non-secret display prefix, e.g. "bp_ab12cd". */
    prefix: text('prefix').notNull(),
    /** The permission keys this key may exercise (subset of the catalogue). */
    scopes: jsonb('scopes').notNull().default([]),
    createdByUserId: refId('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('api_keys_key_hash_unique').on(table.keyHash),
    index('api_keys_org_idx').on(table.organisationId),
    index('api_keys_created_by_idx').on(table.createdByUserId),
  ],
);

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organisation: one(organisations, {
    fields: [apiKeys.organisationId],
    references: [organisations.id],
  }),
  createdBy: one(users, {
    fields: [apiKeys.createdByUserId],
    references: [users.id],
  }),
}));
