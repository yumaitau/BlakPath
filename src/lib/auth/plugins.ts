import { passkey } from '@better-auth/passkey';
import { twoFactor } from 'better-auth/plugins';

/**
 * Persisted second-factor lockout. These match the two-factor plugin defaults
 * (10 consecutive failures, 15 minutes) and are stated here so the sign-in
 * policy and its tests share one figure. The count and deadline are stored on
 * the factor row.
 */
export const TOTP_ACCOUNT_LOCKOUT = {
  enabled: true,
  maxFailedAttempts: 10,
  durationSeconds: 15 * 60,
} as const;

/**
 * Plugins mounted on the Better Auth instance. Schema coverage reads this same
 * list, so a new plugin cannot ship without a matching Drizzle table.
 */
export function createAuthPlugins(appUrl: string) {
  return [
    /**
     * TOTP two-factor with recovery codes. `skipVerificationOnEnable: false`
     * forces the user to prove they can generate a valid code before 2FA is
     * activated, so nobody locks themselves out with a mis-scanned secret.
     */
    twoFactor({
      issuer: 'BlakPath',
      skipVerificationOnEnable: false,
      backupCodes: {
        amount: 10,
        length: 10,
      },
      accountLockout: TOTP_ACCOUNT_LOCKOUT,
    }),

    /**
     * WebAuthn passkeys — phishing-resistant, the preferred staff second
     * factor. `rpID`/`origin` are derived from the configured app URL so
     * credentials are bound to this origin only.
     */
    passkey({
      rpID: new URL(appUrl).hostname,
      rpName: 'BlakPath',
      origin: appUrl,
    }),
  ];
}
