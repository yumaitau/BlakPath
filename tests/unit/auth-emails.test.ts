import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({
  sendVerificationEmail: vi.fn(async () => undefined),
  sendPasswordResetEmail: vi.fn(async () => undefined),
}));

vi.mock('@/lib/email/mailer', () => ({
  authMailer: sent,
  sendEmail: vi.fn(),
}));

const { sendPasswordResetEmail, sendVerificationEmail, setAuthMailer } =
  await import('@/lib/auth/emails');

const message = {
  to: 'ada@council.example',
  name: 'Ada',
  url: 'https://council.example/reset/secret',
  token: 'secret',
};

beforeEach(() => {
  sent.sendVerificationEmail.mockClear();
  sent.sendPasswordResetEmail.mockClear();
});

describe('auth emails', () => {
  it('sends verification and reset through the shared mailer without logging the link', async () => {
    await sendVerificationEmail(message);
    await sendPasswordResetEmail(message);
    expect(sent.sendVerificationEmail).toHaveBeenCalledWith(message);
    expect(sent.sendPasswordResetEmail).toHaveBeenCalledWith(message);
  });

  it('uses an injected mailer when tests replace the transport', async () => {
    const replacement = {
      sendVerificationEmail: vi.fn(async () => undefined),
      sendPasswordResetEmail: vi.fn(async () => undefined),
    };
    setAuthMailer(replacement);
    await sendVerificationEmail(message);
    await sendPasswordResetEmail(message);
    expect(replacement.sendVerificationEmail).toHaveBeenCalledWith(message);
    expect(sent.sendVerificationEmail).not.toHaveBeenCalled();
  });
});
