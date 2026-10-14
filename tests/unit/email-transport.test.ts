import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  suppressed: false,
  sesSend: vi.fn(),
  sesConfig: undefined as unknown,
  smtpSend: vi.fn(),
  smtpOptions: undefined as unknown,
}));

vi.mock('@/domains/email/service', () => ({
  isSuppressed: async () => state.suppressed,
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    constructor(config: unknown) {
      state.sesConfig = config;
    }
    send(command: { input: unknown }) {
      return state.sesSend(command.input);
    }
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: unknown) => {
      state.smtpOptions = options;
      return { sendMail: state.smtpSend };
    },
  },
}));

// Dynamic import after vi.stubEnv: the env proxy caches on first read.
async function freshMailer() {
  const { __resetEnvCache } = await import('@/lib/env');
  __resetEnvCache();
  const holder = globalThis as { __blakpathMailer?: unknown; __blakpathSes?: unknown };
  delete holder.__blakpathMailer;
  delete holder.__blakpathSes;
  return import('@/lib/email/mailer');
}

const message = { to: 'person@example.org', subject: 'Hello', text: 'Body' };

describe('email transport', () => {
  beforeEach(() => {
    state.suppressed = false;
    state.sesSend.mockReset().mockResolvedValue({ MessageId: 'ses-1' });
    state.smtpSend.mockReset().mockResolvedValue({});
    state.sesConfig = undefined;
    state.smtpOptions = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends through the SES API with the configuration set under the workload role', async () => {
    vi.stubEnv('EMAIL_TRANSPORT', 'ses');
    vi.stubEnv('SES_CONFIGURATION_SET', 'blakpath-production');
    vi.stubEnv('APP_REGION', 'ap-southeast-2');
    vi.stubEnv('SMTP_FROM', 'BlakPath <no-reply@blakpath.yumait.au>');
    const { sendEmail } = await freshMailer();

    await sendEmail(message);

    expect(state.smtpSend).not.toHaveBeenCalled();
    expect(state.sesConfig).toMatchObject({ region: 'ap-southeast-2', maxAttempts: 3 });
    // No static credentials: the SDK resolves the role chain.
    expect(state.sesConfig).not.toHaveProperty('credentials');
    expect(state.sesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        FromEmailAddress: 'BlakPath <no-reply@blakpath.yumait.au>',
        Destination: { ToAddresses: ['person@example.org'] },
        ConfigurationSetName: 'blakpath-production',
      }),
    );
  });

  it('uses unauthenticated SMTP (Mailpit) by default outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { sendEmail } = await freshMailer();

    await sendEmail(message);

    expect(state.sesSend).not.toHaveBeenCalled();
    expect(state.smtpOptions).not.toHaveProperty('auth');
    expect(state.smtpSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'person@example.org', subject: 'Hello' }),
    );
  });

  it('refuses the SMTP transport in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_TRANSPORT', 'smtp');
    const { sendEmail } = await freshMailer();

    await expect(sendEmail(message)).rejects.toThrow(/not permitted in production/);
    expect(state.smtpSend).not.toHaveBeenCalled();
    expect(state.sesSend).not.toHaveBeenCalled();
  });

  it('skips suppressed recipients on every transport', async () => {
    state.suppressed = true;
    vi.stubEnv('EMAIL_TRANSPORT', 'ses');
    const { sendEmail } = await freshMailer();

    await sendEmail(message);

    expect(state.sesSend).not.toHaveBeenCalled();
    expect(state.smtpSend).not.toHaveBeenCalled();
  });

  it('propagates SES failures so the queue retries', async () => {
    vi.stubEnv('EMAIL_TRANSPORT', 'ses');
    state.sesSend.mockRejectedValue(new Error('Throttling'));
    const { sendEmail } = await freshMailer();

    await expect(sendEmail(message)).rejects.toThrow('Throttling');
  });
});

describe('SES event parsing', () => {
  async function targets(message: unknown) {
    const { parseSesEvent, suppressionTargets } = await import('@/domains/email/events');
    const parsed = parseSesEvent(JSON.stringify(message));
    return parsed ? suppressionTargets(parsed) : null;
  }

  it('suppresses permanent bounces from configuration-set event publishing', async () => {
    const { parseSesEvent } = await import('@/domains/email/events');
    const raw = {
      eventType: 'Bounce',
      mail: { messageId: 'm-1' },
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'gone@example.org' }],
      },
    };
    expect(parseSesEvent(JSON.stringify(raw))).toMatchObject({
      notificationType: 'Bounce',
      mail: { messageId: 'm-1' },
    });
    expect(await targets(raw)).toEqual([{ address: 'gone@example.org', kind: 'bounce' }]);
  });

  it('suppresses complaints from identity notifications', async () => {
    expect(
      await targets({
        notificationType: 'Complaint',
        complaint: { complainedRecipients: [{ emailAddress: 'no@example.org' }] },
      }),
    ).toEqual([{ address: 'no@example.org', kind: 'complaint' }]);
  });

  it.each(['Transient', 'Undetermined'])('ignores %s bounces', async (bounceType) => {
    expect(
      await targets({
        eventType: 'Bounce',
        bounce: { bounceType, bouncedRecipients: [{ emailAddress: 'full@example.org' }] },
      }),
    ).toEqual([]);
  });

  it('acknowledges other event types without suppressing', async () => {
    expect(await targets({ eventType: 'Delivery' })).toEqual([]);
  });

  it('rejects malformed messages', async () => {
    const { parseSesEvent } = await import('@/domains/email/events');
    expect(parseSesEvent('not json')).toBeNull();
    expect(parseSesEvent(JSON.stringify({ mail: {} }))).toBeNull();
  });
});
