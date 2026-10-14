import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { uuidv7 } from 'uuidv7';
import { db, schema } from '@/db/client';
import { env, isProduction } from '@/lib/env';
import { AUTH_LIMITS } from '@/lib/http/request-limits';
import { sendVerificationEmail, sendPasswordResetEmail } from './emails';
import { recordPasskeyRegistration, staffMfaDatabaseHooks } from './mfa-audit';
import { createAuthPlugins } from './plugins';
import { createAuthRateLimitStorage } from './rate-limit-storage';
import { assertAuthSchemaCoverage } from './schema-coverage';
import { REVOKE_SESSIONS_ON_PASSWORD_RESET } from './session-policy';
import {
  SignInLockedError,
  emailFromBody,
  guardSignIn,
  noteSignInResult,
  signInOutcome,
} from './sign-in-guard';
import { ssoPlugin } from './sso-plugin';
import { stepUp } from './step-up-plugin';

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
 *   Enrolment and second-factor lockout are stored on the auth tables; see
 *   `schema-coverage.ts`.
 * - Cookies are httpOnly + SameSite=Lax, and Secure in production. Production
 *   names use the `__Host-` prefix (Path=/, no Domain) so they cannot be
 *   scoped to a parent domain. A session with an active organisation expires
 *   12 hours after it is created, and sooner when idle (30–60 minutes, per
 *   tenant). Other sessions keep a 7-day ceiling. Sensitive routes require a
 *   fresh authentication via step-up.
 * - Rate limiting is enabled to blunt credential-stuffing and brute force; the
 *   TOTP plugin records repeated failed second-factor attempts on the factor
 *   row and refuses verification until the lock window ends.
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

/** Hash a credential password with the same Argon2id parameters sign-in uses. */
export function hashCredentialPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

assertAuthSchemaCoverage();

/** Legacy cache-cookie names, plus the production `__Host-` name, to expire. */
export const SESSION_DATA_COOKIE_NAMES = [
  'blakpath.session_data',
  '__Secure-blakpath.session_data',
  '__Host-blakpath.session_data',
] as const;

/**
 * `__Host-` cookies must be Secure, Path=/, and must not set Domain.
 * Better Auth prepends `__Secure-` when `useSecureCookies` is on, which would
 * produce a name that does not start with `__Host-`, so production sets the
 * full name explicitly and leaves that flag off.
 */
function hostCookie(cookieName: string) {
  return {
    name: `__Host-blakpath.${cookieName}`,
    attributes: {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: true,
      path: '/',
    },
  };
}

const HOST_ONLY_SESSION_COOKIES = isProduction();

export const auth = betterAuth({
  appName: 'BlakPath',
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  /**
   * OAuth access and refresh tokens are encrypted with the platform auth
   * secret before storage. This is not the tenant CMK. Tokens that do not
   * already look encrypted still read back as stored. Federated sign-in
   * (`sso-plugin.ts`) deliberately stores no IdP tokens at all.
   */
  account: {
    encryptOAuthTokens: true,
  },

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
    revokeSessionsOnPasswordReset: REVOKE_SESSIONS_ON_PASSWORD_RESET,
    password: {
      hash: (password) => hashCredentialPassword(password),
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
   * - `expiresIn`: 7-day ceiling for a session that has not selected an
   *   organisation. Staff sessions (an active organisation is set) are capped
   *   in `getServerSession`: 12 hours from `createdAt`, and an idle timeout of
   *   30–60 minutes from `updatedAt` (`staff-session-policy.ts`).
   * - `updateAge`: Better Auth may extend `expiresAt` at most once a day. Staff
   *   idle is checked on each read, so that daily slide cannot outlive it.
   * - `freshAge` is Better Auth's own hint. Sensitive routes do not use it;
   *   they call `requireRecentAuth` with `STEP_UP_ROUTES`.
   * - `cookieCache` stays off so organisation selection is read from the row.
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
      // Stamped when the session is created and again on step-up. Step-up
      // reads this, falling back to `createdAt` when it is null.
      lastAuthenticatedAt: {
        type: 'date',
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
    // Rate limits and session addresses read CF-Connecting-IP. The auth route
    // sets that header only after clientIp accepts the request, and removes
    // client-supplied forwarding headers first. `useSecureCookies` would prefix
    // `__Secure-` and break the `__Host-` names used in production.
    ipAddress: {
      ipAddressHeaders: ['cf-connecting-ip'],
    },
    useSecureCookies: false,
    cookiePrefix: 'blakpath',
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: HOST_ONLY_SESSION_COOKIES,
      path: '/',
    },
    ...(HOST_ONLY_SESSION_COOKIES
      ? {
          cookies: {
            session_token: hostCookie('session_token'),
            session_data: hostCookie('session_data'),
            account_data: hostCookie('account_data'),
            dont_remember: hostCookie('dont_remember'),
            two_factor: hostCookie('two_factor'),
            trust_device: hostCookie('trust_device'),
          },
        }
      : {}),
    // Application-generated UUIDv7 so ids are known pre-insert (audit hash
    // chaining, object-storage keys) and are time-ordered for indexing.
    database: {
      generateId: () => uuidv7(),
    },
  },

  /**
   * Enrolment audit. TOTP completion is observed from the user update that
   * marks the factor enabled. Passkey registration is observed from the
   * verification endpoint. Neither hook decides access.
   */
  databaseHooks: {
    ...staffMfaDatabaseHooks,
    session: {
      create: {
        before: async (session: Record<string, unknown>) => {
          if (session.lastAuthenticatedAt) return;
          return { data: { lastAuthenticatedAt: new Date() } };
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const email = emailFromBody(ctx.body);
      if (!email) return;
      try {
        await guardSignIn(email);
      } catch (error) {
        if (error instanceof SignInLockedError) {
          throw APIError.fromStatus('TOO_MANY_REQUESTS', {
            message: 'Too many requests',
          });
        }
        throw error;
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      await recordPasskeyRegistration(ctx);
      if (ctx.path !== '/sign-in/email') return;
      const email = emailFromBody(ctx.body);
      if (!email) return;
      const outcome = signInOutcome((ctx.context as { returned?: unknown }).returned);
      if (outcome) await noteSignInResult(email, outcome);
    }),
  },

  /**
   * Rate limiting. Windows below are per client IP and shared across replicas
   * via Redis (`customStorage`). Do not set `secondaryStorage` — Better Auth
   * would then serve sessions and verification tokens from Redis and skip the
   * Postgres row that holds the active organisation and two-factor state.
   */
  rateLimit: {
    enabled: true,
    window: AUTH_LIMITS.window,
    max: AUTH_LIMITS.max,
    customStorage: createAuthRateLimitStorage(),
    customRules: {
      '/sign-in/email': AUTH_LIMITS.signInEmail,
      '/sign-up/email': AUTH_LIMITS.signUpEmail,
      '/forget-password': AUTH_LIMITS.forgetPassword,
      '/request-password-reset': AUTH_LIMITS.requestPasswordReset,
      '/reset-password': AUTH_LIMITS.resetPassword,
      '/two-factor/verify-totp': AUTH_LIMITS.verifyTotp,
      '/two-factor/verify-backup-code': AUTH_LIMITS.verifyBackupCode,
      '/step-up': { window: 60, max: 5 },
    },
  },

  plugins: [
    ...createAuthPlugins(env.BETTER_AUTH_URL),
    stepUp(),
    /**
     * Tenant-bound federated sign-in (Entra ID OIDC). Inert unless a provider
     * is configured AND an organisation has an enabled binding on a verified
     * domain; password + MFA remain the default path.
     */
    ssoPlugin(),
  ],
});

export type Auth = typeof auth;
