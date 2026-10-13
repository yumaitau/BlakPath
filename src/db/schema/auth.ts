import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { primaryId, refId, timestamps } from './_helpers';

/**
 * Authentication tables.
 *
 * These back Better Auth's Drizzle adapter and follow the Better Auth v1 core
 * table shape (user, session, account, verification) plus the passkey and
 * two-factor plugin tables. Column names are chosen so the adapter maps
 * cleanly; the Drizzle snake_case mapper handles the DB naming.
 *
 * Secrets (passwords, TOTP secrets, backup codes) are never stored in
 * plaintext — see the per-column notes. Sign-in itself is an audited event,
 * but the audit trail lives in `audit.ts`, not here.
 */

/**
 * A human account. Maps to Better Auth's `user` model.
 *
 * `isPlatformOperator` marks BlakPath support/platform staff. It grants NO
 * tenant data access on its own — cross-tenant access is only ever obtained
 * through the audited break-glass flow (see `audit.ts`).
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    /** Platform (BlakPath) staff flag. Not a tenant role; grants no tenant data. */
    isPlatformOperator: boolean('is_platform_operator').notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

/**
 * A federated or credential account linked to a user. Maps to Better Auth's
 * `account`. Passwords are hashed by Better Auth before reaching this table;
 * this schema never sees or stores a plaintext credential.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: primaryId(),
    userId: refId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** OAuth provider id, or 'credential' for email+password. */
    providerId: text('provider_id').notNull(),
    /** The user's id at the provider (for credential accounts: the user id). */
    accountId: text('account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    /** Better-Auth-hashed password for credential accounts. Never plaintext. */
    password: text('password'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('accounts_provider_account_unique').on(table.providerId, table.accountId),
  ],
);

/**
 * An authenticated session. Maps to Better Auth's `session`.
 *
 * `activeOrganisationId` records which tenant the session is currently acting
 * within; it is advisory only — every request re-derives and DB-verifies the
 * tenant context (see tenancy layer). `lastAuthenticatedAt` supports step-up /
 * recent-auth checks for sensitive actions.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    token: text('token').notNull(),
    userId: refId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** Advisory: the tenant this session is currently acting within. */
    activeOrganisationId: refId('active_organisation_id'),
    /** Timestamp of the most recent successful authentication (step-up gate). */
    lastAuthenticatedAt: timestamp('last_authenticated_at', {
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [uniqueIndex('sessions_token_unique').on(table.token)],
);

/**
 * Short-lived verification values (email verification, password reset, OTP).
 * Maps to Better Auth's `verification`. Values are single-use and expiring.
 */
export const verifications = pgTable('verifications', {
  id: primaryId(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ...timestamps,
});

/**
 * WebAuthn / passkey credential (Better Auth passkey plugin).
 * `publicKey` is a public credential; no private key material is ever stored.
 */
export const passkeys = pgTable(
  'passkeys',
  {
    id: primaryId(),
    name: text('name'),
    userId: refId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Base64url credential id — globally unique per WebAuthn spec. */
    credentialID: text('credential_id').notNull(),
    /** COSE public key. Public material only. */
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up').notNull().default(false),
    /** Comma-separated authenticator transports (e.g. 'internal,hybrid'). */
    transports: text('transports'),
    ...timestamps,
  },
  (table) => [uniqueIndex('passkeys_credential_id_unique').on(table.credentialID)],
);

/**
 * TOTP two-factor secret and recovery codes (Better Auth twoFactor plugin).
 *
 * Better Auth 1.6 encrypts `secret` and `backupCodes` with
 * XChaCha20-Poly1305 under SHA-256(BETTER_AUTH_SECRET) before insert
 * (`symmetricEncrypt`). That is not `encryptField`, not
 * `ENCRYPTION_MASTER_KEY`, and not a KMS data key. Plaintext exists in the
 * auth process during enrolment and verification.
 */
export const twoFactors = pgTable('two_factors', {
  id: primaryId(),
  userId: refId('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Better Auth ciphertext of the TOTP secret. Not a KMS envelope. */
  secret: text('secret').notNull(),
  /** Better Auth ciphertext of the recovery codes. Not a KMS envelope. */
  backupCodes: text('backup_codes').notNull(),
  ...timestamps,
});

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  passkeys: many(passkeys),
  twoFactors: many(twoFactors),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const passkeysRelations = relations(passkeys, ({ one }) => ({
  user: one(users, {
    fields: [passkeys.userId],
    references: [users.id],
  }),
}));

export const twoFactorsRelations = relations(twoFactors, ({ one }) => ({
  user: one(users, {
    fields: [twoFactors.userId],
    references: [users.id],
  }),
}));
