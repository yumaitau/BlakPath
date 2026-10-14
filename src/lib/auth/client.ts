import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';

/**
 * Better Auth browser client for BlakPath.
 *
 * SECURITY INTENT
 * ---------------
 * This runs in the browser. It carries NO secrets — authentication state lives
 * in httpOnly cookies the client cannot read, and every privileged decision is
 * re-made and audited on the server. The client only initiates flows (sign in,
 * enrol a passkey, verify a TOTP code) and reflects reactive session state.
 *
 * `baseURL` is intentionally omitted: the app is served from the same origin as
 * the auth API (`/api/auth/*`), so same-origin requests keep cookies scoped to
 * this origin and avoid a cross-origin surface.
 *
 * The `onTwoFactorRedirect` hook routes a partially-authenticated user (correct
 * password, second factor still owed) to the verification screen. It exposes no
 * secret and makes no authorisation decision — it is navigation only.
 */
export const authClient = createAuthClient({
  plugins: [
    passkeyClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        if (typeof window !== 'undefined') {
          // Carry `returnTo` through so the second factor lands on the same
          // page; the verification screen re-validates it before use.
          const returnTo = new URLSearchParams(window.location.search).get('returnTo');
          window.location.href = returnTo
            ? `/sign-in/two-factor?${new URLSearchParams({ returnTo })}`
            : '/sign-in/two-factor';
        }
      },
    }),
  ],
});

/**
 * Reactive hooks and imperative actions, re-exported for ergonomic imports in
 * client components. Prefer these named exports over reaching into
 * `authClient.*` directly so usage is greppable.
 */
export const {
  useSession,
  signIn,
  signOut,
  signUp,
  passkey,
  twoFactor,
  updateUser,
  changePassword,
  getSession,
} = authClient;

export type AuthClient = typeof authClient;
