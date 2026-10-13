import nodemailer, { type Transporter } from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { env, isProduction } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import type { AuthMailer, AuthEmailMessage } from '@/lib/auth/emails';

/**
 * Email transport.
 *
 * Exactly one production sender (docs/adr/0090-production-email-sender.md):
 *   - `EMAIL_TRANSPORT=ses`: SES v2 API in APP_REGION under the pod/task IAM
 *     role (EKS Pod Identity). No static credentials anywhere. Every message
 *     is tagged with SES_CONFIGURATION_SET so bounce/complaint events reach
 *     POST /api/email/events via SNS.
 *   - `EMAIL_TRANSPORT=smtp` (default): unauthenticated SMTP to Mailpit for
 *     local development and CI. Refused in production.
 *
 * AUTH emails (verification, password reset) send synchronously; TENANT
 * emails (invitations, notification copies) go through the Email queue, which
 * retries with backoff. Bodies may contain bearer links: logged metadata
 * only, never content.
 */

/** Bound synchronous auth sends so a slow provider cannot hang a request. */
const SES_CONNECTION_TIMEOUT_MS = 3_000;
const SES_REQUEST_TIMEOUT_MS = 10_000;
const SES_MAX_ATTEMPTS = 3;

const globalForMailer = globalThis as unknown as {
  __blakpathMailer?: Transporter;
  __blakpathSes?: SESv2Client;
};

/** Lazily create (once) the local SMTP transport from validated env. */
function getTransport(): Transporter {
  if (globalForMailer.__blakpathMailer) return globalForMailer.__blakpathMailer;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Mailpit speaks plain SMTP on 1025; enable TLS only for the
    // conventional secure port.
    secure: env.SMTP_PORT === 465,
  });
  globalForMailer.__blakpathMailer = transport;
  return transport;
}

/** Lazily create (once) the SES client. Credentials come from the role chain. */
function getSesClient(): SESv2Client {
  if (globalForMailer.__blakpathSes) return globalForMailer.__blakpathSes;
  const client = new SESv2Client({
    region: env.APP_REGION,
    maxAttempts: SES_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: SES_CONNECTION_TIMEOUT_MS,
      requestTimeout: SES_REQUEST_TIMEOUT_MS,
    },
  });
  globalForMailer.__blakpathSes = client;
  return client;
}

/** Redact the local part of an address so logs never carry a full identity. */
function redact(address: string): string {
  const at = address.indexOf('@');
  if (at <= 1) return '***';
  return `${address[0]}***${address.slice(at)}`;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send a single email through the configured transport. Used by the worker's
 * Email/Notification processors and the auth mailer. Logs only redacted
 * recipient and subject — never the body (which may contain a bearer link).
 */
export async function sendEmail({
  to,
  subject,
  text,
  html,
}: SendEmailInput): Promise<void> {
  const { isSuppressed } = await import('@/domains/email/service');
  if (await isSuppressed(to)) {
    logger.info({ to: redact(to) }, 'email suppressed (bounce/complaint) — skipping');
    return;
  }
  if (env.EMAIL_TRANSPORT === 'ses') {
    const result = await getSesClient().send(
      new SendEmailCommand({
        FromEmailAddress: env.SMTP_FROM,
        Destination: { ToAddresses: [to] },
        ...(env.SES_CONFIGURATION_SET
          ? { ConfigurationSetName: env.SES_CONFIGURATION_SET }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: text, Charset: 'UTF-8' },
              ...(html !== undefined ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      }),
    );
    logger.info(
      { to: redact(to), subject, via: 'ses-api', messageId: result.MessageId },
      'email sent',
    );
    return;
  }
  if (isProduction()) {
    // Fail closed: SMTP is the local Mailpit catch-all, never a production path.
    throw new Error('SMTP email transport is not permitted in production');
  }
  await getTransport().sendMail({
    from: env.SMTP_FROM,
    to,
    subject,
    text,
    ...(html !== undefined ? { html } : {}),
  });
  logger.info({ to: redact(to), subject, via: 'smtp' }, 'email sent');
}

/* ---------------------------------------------------------------------------
 * Auth transport (verification + password reset). Calm, plain Australian
 * English. The URL is a bearer secret — it goes in the body, never the logs.
 * ------------------------------------------------------------------------- */

function verificationText(name: string, url: string): string {
  return [
    `Hi ${name},`,
    '',
    'Please confirm your email address to finish setting up your BlakPath account.',
    'Open the link below to confirm. It will expire soon, so it is best to do this now.',
    '',
    url,
    '',
    'If you did not create a BlakPath account, you can safely ignore this email.',
    '',
    'BlakPath',
  ].join('\n');
}

function passwordResetText(name: string, url: string): string {
  return [
    `Hi ${name},`,
    '',
    'We received a request to reset the password on your BlakPath account.',
    'Open the link below to choose a new password. It will expire soon.',
    '',
    url,
    '',
    'If you did not request this, no change has been made and you can ignore this email.',
    '',
    'BlakPath',
  ].join('\n');
}

/**
 * The production auth transport injected into better-auth via `setAuthMailer`
 * at startup (see `src/instrumentation.ts`). Sends synchronously.
 */
export const authMailer: AuthMailer = {
  async sendVerificationEmail({ to, name, url }: AuthEmailMessage): Promise<void> {
    await sendEmail({
      to,
      subject: 'Confirm your BlakPath email address',
      text: verificationText(name, url),
    });
  },
  async sendPasswordResetEmail({ to, name, url }: AuthEmailMessage): Promise<void> {
    await sendEmail({
      to,
      subject: 'Reset your BlakPath password',
      text: passwordResetText(name, url),
    });
  },
};
