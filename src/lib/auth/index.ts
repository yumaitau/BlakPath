import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { uuidv7 } from 'uuidv7';
import { db, schema } from '@/db/client';
import { env, isProduction } from '@/lib/env';
import { sendVerificationEmail, sendPasswordResetEmail } from './emails';

/**
 * Better Auth configuration for BlakPath.
 *
 * SECURITY INTENT
 * ---------------
 * This is the platform authentication boundary. It authenticates *who* a person
 * is; it never decides *what* they may do inside a tenant. Authorisation and
 * strict tenant isolation are enforced separately (see the tenancy and
 * permission layers). Authentication here grants no tenant data access on its
 * own.
 *
 * - Passwords are hashed with Argon2id (memory-hard) via `@node-rs/argon2`,
 *   using OWASP-aligned parameters. Plaintext credentials never touch the DB.
 * - MFA is first-class: WebAuthn passkeys (phishing-resistant, preferred) and
 *   TOTP with recovery codes. Staff MFA is enforced by `staff-policy.ts`.
 * - Cookies are httpOnly + SameSite=Lax, and Secure in production. Sessions
 *   are short-lived with sliding renewal and an explicit "remember me" ceiling.
 * - Rate limiting is enabled to blunt credential-stuffing and brute force; the
 *   TOTP plugin enforces account lockout on repeated failed second-factor
 *   attempts.
 * - IDs are application-generated UUIDv7 so they are known before insert and
 *   are time-ordered, matching the Drizzle schema's `uuid` primary keys.
 *
 * The Drizzle schema uses pluralised table exports (`users`, `sessions`, ...),
 * so we map Better Auth's singular model names onto them explicitly. Never
 * rely on `usePlural` here — the mapping is stated openly so a reviewer can see
 * exactly which table backs which model.
 */

/**
 * Argon2id parameters. Memory-hard settings aligned with current OWASP
 * guidance (>= 19 MiB memory, >= 2 iterations). Tuned upward from library
 * defaults; do not lower without a security review.
 */
const ARGON2_OPTIONS = {
  // Algorithm 2 = Argon2id in @node-rs/argon2. The numeric literal avoids
  // importing the library's ambient const enum, which `verbatimModuleSyntax`
  // forbids referencing as a value.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export const auth = betterAuth({
  appName: 'BlakPath',
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  database: drizzleAdapter(db, {
    provider: 'pg',
    // Map Better Auth's singular model names onto our pluralised Drizzle tables.
    schema: {
      user: schema.users,
      account: schema.accounts,
      session: schema.sessions,
      verification: schema.verifications,
      passkey: schema.passkeys,
      twoFactor: schema.twoFactors,
    },
  }),

  /**
   * Email + password with mandatory verification and self-service reset.
   * Argon2id is wired via the `password` hook so Better Auth never uses its
   * default hasher for BlakPath credentials.
   *
   * INVITE-ONLY: `disableSignUp` closes open self-registration. Accounts are
   * created only through an organisation invitation
   * (`createInvitedAccount` in the memberships domain), which binds creation
   * to a pending invitation token for a specific email. Sign-in stays open.
   */
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 256,
    autoSignIn: false,
    password: {
      hash: (password) => argon2Hash(password, ARGON2_OPTIONS),
      verify: ({ hash, password }) => argon2Verify(hash, password),
    },
    sendResetPassword: async ({ user, url, token }) => {
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        url,
        token,
      });
    },
  },

  /**
   * Email verification. We do NOT auto-sign-in after verification: a verified
   * email is a prerequisite, not an authorisation event.
   */
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    sendVerificationEmail: async ({ user, url, token }) => {
      await sendVerificationEmail({
        to: user.email,
        name: user.name,
        url,
        token,
      });
    },
  },

  /**
   * Session policy.
   *
   * - `expiresIn`: 7 days maximum absolute lifetime for a standard session.
   * - `updateAge`: sliding renewal — an active session's expiry is extended at
   *   most once per day, so a genuinely idle session still ages out.
   * - `freshAge`: a session is only considered "fresh" (usable for sensitive,
   *   step-up-gated actions) for 15 minutes after authentication. This backs
   *   `requireRecentAuth` in `session.ts`.
   * - `cookieCache`: short-lived signed cache to avoid a DB hit on every
   *   request without extending trust beyond a minute.
   */
  session: {
    additionalFields: {
      // This is written only by the verified organisation-selection service.
      // Exposing it in the server session lets the tenancy layer re-verify it
      // on every request; clients cannot submit or alter it through Better Auth.
      activeOrganisationId: {
        type: 'string',
        required: false,
        input: false,
      },
    },
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 15,
    cookieCache: {
      // Active organisation selection is server-authorised state. Keeping it in
      // a short-lived browser cache made a successful organisation switch look
      // like it had failed until the cache expired. Read the session row on
      // each request instead, so a role or tenant change takes effect at once.
      enabled: false,
    },
  },

  /**
   * "Remember me" is handled by Better Auth's `rememberMe` sign-in flag; when a
   * client does not opt in, the session cookie is a browser-session cookie that
   * dies when the browser closes. The absolute `expiresIn` above is the ceiling
   * either way.
   */
  advanced: {
    // Cookies are Secure in production (HTTPS-only). Even in development the
    // flags below keep them httpOnly and SameSite=Lax.
    useSecureCookies: isProduction(),
    cookiePrefix: 'blakpath',
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction(),
      path: '/',
    },
    // Application-generated UUIDv7 so ids are known pre-insert (audit hash
    // chaining, object-storage keys) and are time-ordered for indexing.
    database: {
      generateId: () => uuidv7(),
    },
  },

  /**
   * Rate limiting. Enabled globally with tighter custom rules on the
   * credential-bearing endpoints to blunt credential stuffing and brute force.
   * Backed by the shared store (memory in dev; wire to secondary storage in
   * production infra).
   */
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 60, max: 5 },
      '/forget-password': { window: 60, max: 3 },
      '/reset-password': { window: 60, max: 5 },
      '/two-factor/verify-totp': { window: 60, max: 5 },
      '/two-factor/verify-backup-code': { window: 60, max: 5 },
    },
  },

  plugins: [
    /**
     * TOTP two-factor with recovery codes. `skipVerificationOnEnable: false`
     * forces the user to prove they can generate a valid code before 2FA is
     * activated, so nobody locks themselves out with a mis-scanned secret.
     * Account lockout on repeated failed second-factor attempts is handled by
     * the plugin's built-in failure handling.
     */
    twoFactor({
      issuer: 'BlakPath',
      skipVerificationOnEnable: false,
      backupCodes: {
        amount: 10,
        length: 10,
      },
    }),

    /**
     * WebAuthn passkeys — phishing-resistant, the preferred staff second
     * factor. `rpID`/`origin` are derived from the configured app URL so
     * credentials are bound to this origin only.
     */
    passkey({
      rpID: new URL(env.BETTER_AUTH_URL).hostname,
      rpName: 'BlakPath',
      origin: env.BETTER_AUTH_URL,
    }),
  ],
});

export type Auth = typeof auth;
