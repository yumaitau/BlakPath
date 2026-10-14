import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Auth and tenant mail share `sendEmail`. Production without SMTP_USER uses
 * the SES API; a configured relay uses SMTP. Suppressed addresses never send.
 * Bearer links stay in the body — logs get a redacted recipient only.
 */

const sendMail = vi.hoisted(() => vi.fn());
const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail })));
const sesSend = vi.hoisted(() => vi.fn());
const sesClients = vi.hoisted(() => [] as Array<{ region?: string }>);
const isSuppressed = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());

vi.mock('nodemailer', () => ({
  default: { createTransport },
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    constructor(config: { region?: string }) {
      sesClients.push(config);
    }
    send = sesSend;
  },
  SendEmailCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock('@/domains/email/service', () => ({
  isSuppressed,
}));

vi.mock('@/lib/observability/logger', () => ({
  logger: {
    info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const bearerUrl = 'https://app.example/verify?token=secret-bearer';

async function resetMailState(): Promise<void> {
  const { __resetEnvCache } = await import('@/lib/env');
  __resetEnvCache();
  delete (globalThis as { __blakpathMailer?: unknown }).__blakpathMailer;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  sendMail.mockReset();
  sendMail.mockResolvedValue({ messageId: 'smtp-1' });
  sesSend.mockReset();
  sesSend.mockResolvedValue({});
  sesClients.length = 0;
  createTransport.mockClear();
  isSuppressed.mockReset();
  isSuppressed.mockResolvedValue(false);
  info.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sendEmail', () => {
  it('uses the SES API when no SMTP user is configured', async () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    await resetMailState();
    const { authMailer } = await import('@/lib/email/mailer');

    await authMailer.sendVerificationEmail({
      to: 'ada@example.com',
      name: 'Ada',
      url: bearerUrl,
      token: 'secret-bearer',
    });

    expect(createTransport).not.toHaveBeenCalled();
    expect(sesClients).toEqual([{ region: 'ap-southeast-2' }]);
    expect(sesSend).toHaveBeenCalledOnce();
    const command = sesSend.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      FromEmailAddress: 'BlakPath <no-reply@blakpath.local>',
      Destination: { ToAddresses: ['ada@example.com'] },
    });
    const content = command.input.Content as {
      Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } };
    };
    expect(content.Simple.Subject.Data).toBe('Confirm your BlakPath email address');
    expect(content.Simple.Body.Text.Data).toContain(bearerUrl);
    expect(content.Simple.Body.Text.Data).toContain('Hi Ada,');

    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('a***@example.com');
    expect(logged).not.toContain('ada@example.com');
    expect(logged).not.toContain(bearerUrl);
  });

  it('uses SMTP with auth when SMTP_USER is set, and TLS only on port 465', async () => {
    vi.stubEnv('SMTP_USER', 'relay-user');
    vi.stubEnv('SMTP_PASSWORD', 'relay-secret');
    vi.stubEnv('SMTP_PORT', '465');
    vi.stubEnv('SMTP_HOST', 'email-smtp.ap-southeast-2.amazonaws.com');
    await resetMailState();
    const { sendEmail } = await import('@/lib/email/mailer');

    await sendEmail({
      to: 'sam@example.com',
      subject: 'A form is ready',
      text: 'Open https://app.example/form/token-1',
      html: '<p>Open the form</p>',
    });

    expect(sesSend).not.toHaveBeenCalled();
    expect(createTransport).toHaveBeenCalledOnce();
    expect(createTransport).toHaveBeenCalledWith({
      host: 'email-smtp.ap-southeast-2.amazonaws.com',
      port: 465,
      secure: true,
      auth: { user: 'relay-user', pass: 'relay-secret' },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'BlakPath <no-reply@blakpath.local>',
      to: 'sam@example.com',
      subject: 'A form is ready',
      text: 'Open https://app.example/form/token-1',
      html: '<p>Open the form</p>',
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('sam@example.com');
    expect(JSON.stringify(info.mock.calls)).not.toContain('token-1');
  });

  it('sends password reset through the same transport without logging the link', async () => {
    delete process.env.SMTP_USER;
    await resetMailState();
    const { authMailer } = await import('@/lib/email/mailer');

    await authMailer.sendPasswordResetEmail({
      to: 'ada@example.com',
      name: 'Ada',
      url: bearerUrl,
      token: 'secret-bearer',
    });

    const command = sesSend.mock.calls[0]?.[0] as {
      input: {
        Content: {
          Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } };
        };
      };
    };
    expect(command.input.Content.Simple.Subject.Data).toBe(
      'Reset your BlakPath password',
    );
    expect(command.input.Content.Simple.Body.Text.Data).toContain(bearerUrl);
    expect(JSON.stringify(info.mock.calls)).not.toContain(bearerUrl);
  });

  it('skips a suppressed address before either transport', async () => {
    vi.stubEnv('SMTP_USER', 'relay-user');
    isSuppressed.mockResolvedValue(true);
    await resetMailState();
    const { sendEmail } = await import('@/lib/email/mailer');

    await sendEmail({
      to: 'ada@example.com',
      subject: 'Ignored',
      text: bearerUrl,
    });

    expect(sesSend).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      { to: 'a***@example.com' },
      'email suppressed (bounce/complaint) — skipping',
    );
  });
});
