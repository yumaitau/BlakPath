import nodemailer, { type Transporter } from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import type { AuthMailer, AuthEmailMessage } from '@/lib/auth/emails';

/**
 * SMTP email transport.
 *
 * Three paths, chosen per environment:
 *   - Production WITHOUT SMTP_USER: SES API via the pod/task IAM role
 *     (EKS Pod Identity). No static credentials anywhere — preferred.
 *   - SMTP_USER set: SES SMTP interface (or any relay). Kept for
 *     environments without an IAM path.
 *   - Local dev: Mailpit over plain SMTP.
 *
 * AUTH emails (verification, password reset) send synchronously; TENANT
 * emails (invitations, notification copies) go through the Email queue.
 * Bodies may contain bearer links: logged metadata only, never content.
 */

const globalForMailer = globalThis as unknown as { __blakpathMailer?: Transporter };

/** Lazily create (once) the shared SMTP transport from validated env. */
function getTransport(): Transporter {
  if (globalForMailer.__blakpathMailer) return globalForMailer.__blakpathMailer;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Mailpit and most local relays speak plain SMTP on 1025; enable TLS only
    // for the conventional secure port. Real relays advertise STARTTLS anyway.
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } }
      : {}),
  });
  globalForMailer.__blakpathMailer = transport;
  return transport;
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
 * Send a single email. Production without SMTP_USER uses the SES API under
 * the workload IAM role; otherwise the shared SMTP transport. Used by the
 * worker's Email/Notification processors. Logs only redacted recipient and
 * subject — never the body (which may contain a bearer link).
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
  if (!env.SMTP_USER) {
    const client = new SESv2Client({ region: env.S3_REGION });
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: env.SMTP_FROM,
        Destination: { ToAddresses: [to] },
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
    logger.info({ to: redact(to), subject, via: 'ses-api' }, 'email sent');
    return;
  }
  const transport = getTransport();
  await transport.sendMail({
    from: env.SMTP_FROM,
    to,
    subject,
    text,
    ...(html !== undefined ? { html } : {}),
  });
  logger.info({ to: redact(to), subject }, 'email sent');
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
