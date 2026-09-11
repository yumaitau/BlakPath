/**
 * Authentication transactional-email port.
 *
 * SECURITY / DESIGN INTENT
 * ------------------------
 * The auth layer must be able to send verification and password-reset links
 * without hard-wiring transport specifics at import time. Delivery goes
 * through the shared SMTP transport (SES SMTP interface in production) via a
 * lazy dynamic import, so every bundle — dev server, standalone production,
 * worker — resolves the same real transport without relying on a
 * separately-registered module singleton.
 *
 * Bearer links never touch logs: only the template and a redacted recipient
 * are recorded. A different transport can still be injected via
 * `setAuthMailer` (tests, explicit overrides).
 */

/** Copy is trauma-aware, plain, respectful Australian English. */
export interface AuthEmailMessage {
  /** Recipient email address. */
  to: string;
  /** Recipient display name, for a warm greeting. */
  name: string;
  /** Fully-formed, single-use action link. Treat as a bearer secret. */
  url: string;
  /** The raw token embedded in `url`, for transports that template their own link. */
  token: string;
}

/** The minimal transport the auth layer depends on. */
export interface AuthMailer {
  sendVerificationEmail(message: AuthEmailMessage): Promise<void>;
  sendPasswordResetEmail(message: AuthEmailMessage): Promise<void>;
}

/**
 * Default transport.
 *
 * Sends through the real SMTP transport (SES SMTP interface in production,
 * Mailpit locally) via a lazy dynamic import — static import would create a
 * module cycle, and the previous setter-only design silently failed in
 * production bundles where the instrumentation module registry never reached
 * route handlers (found live on EKS: password resets threw "No AuthMailer
 * configured"). Never logs the bearer link. `setAuthMailer` remains for tests
 * and explicit overrides.
 */
const defaultMailer: AuthMailer = {
  async sendVerificationEmail(message) {
    const { authMailer } = await import('@/lib/email/mailer');
    await authMailer.sendVerificationEmail(message);
  },
  async sendPasswordResetEmail(message) {
    const { authMailer } = await import('@/lib/email/mailer');
    await authMailer.sendPasswordResetEmail(message);
  },
};

let mailer: AuthMailer = defaultMailer;

/**
 * Injects the production email transport. Called once, at startup, by the email
 * module. Kept as a setter (not a constructor arg) so `auth/index.ts` can stay
 * a pure module with no wiring order dependency.
 */
export function setAuthMailer(next: AuthMailer): void {
  mailer = next;
}

export function sendVerificationEmail(message: AuthEmailMessage): Promise<void> {
  return mailer.sendVerificationEmail(message);
}

export function sendPasswordResetEmail(message: AuthEmailMessage): Promise<void> {
  return mailer.sendPasswordResetEmail(message);
}
