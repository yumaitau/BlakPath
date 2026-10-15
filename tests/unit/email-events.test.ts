import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetEnvCache } from '@/lib/env';
import {
  isAllowedSigningCertUrl,
  isAllowedSubscribeUrl,
  snsStringToSign,
  verifySnsSignature,
  webhookSecretMatches,
  type SnsEnvelope,
} from '@/lib/email/sns';
import { suppressionTargets, type SesEvent } from '@/domains/email/events';

const recordSuppression = vi.hoisted(() => vi.fn(async () => ({ suppressed: true })));

vi.mock('@/domains/email', () => ({ recordSuppression }));

import { POST } from '@/app/api/email/events/route';

const SECRET = 'test-webhook-secret-value';
const TOPIC = 'arn:aws:sns:ap-southeast-2:123456789012:blakpath-email-events';
const CERT_URL =
  'https://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-TestCert.pem';

let certPem = '';
let privateKey = '';

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === CERT_URL) return new Response(certPem, { status: 200 });
  if (url.startsWith('https://sns.ap-southeast-2.amazonaws.com/?')) {
    return new Response('ok', { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
});

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sns-test-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-nodes',
      '-subj',
      '/CN=sns.ap-southeast-2.amazonaws.com',
    ],
    { stdio: 'ignore' },
  );
  certPem = readFileSync(certPath, 'utf8');
  privateKey = readFileSync(keyPath, 'utf8');
});

beforeEach(() => {
  process.env.EMAIL_WEBHOOK_SECRET = SECRET;
  process.env.EMAIL_SNS_TOPIC_ARN = TOPIC;
  __resetEnvCache();
  recordSuppression.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  delete process.env.EMAIL_WEBHOOK_SECRET;
  delete process.env.EMAIL_SNS_TOPIC_ARN;
  __resetEnvCache();
  vi.unstubAllGlobals();
});

function sign(message: SnsEnvelope, version: '1' | '2' = '2'): SnsEnvelope {
  const envelope = { ...message, SignatureVersion: version };
  const canonical = snsStringToSign(envelope);
  if (!canonical) throw new Error('missing signature fields');
  const signature = createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1')
    .update(canonical, 'utf8')
    .sign(privateKey, 'base64');
  return { ...envelope, Signature: signature };
}

function notification(
  message: unknown,
  overrides: Partial<SnsEnvelope> = {},
): SnsEnvelope {
  return sign({
    Type: 'Notification',
    MessageId: 'mid-1',
    TopicArn: TOPIC,
    Timestamp: '2026-10-13T00:00:00.000Z',
    SigningCertURL: CERT_URL,
    Message: typeof message === 'string' ? message : JSON.stringify(message),
    ...overrides,
  });
}

function call(
  body: unknown,
  options: { path?: string; secret?: string | null } = {},
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.secret !== null)
    headers.set('x-email-webhook-secret', options.secret ?? SECRET);
  return POST(
    new NextRequest(`http://localhost${options.path ?? '/api/email/events'}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe('SNS signing certificate URL', () => {
  it('allows only an SNS PEM URL', () => {
    expect(isAllowedSigningCertUrl(CERT_URL)).toBe(true);
    expect(
      isAllowedSigningCertUrl(
        'https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-Ab12.pem',
      ),
    ).toBe(true);
    expect(
      isAllowedSigningCertUrl(
        'http://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-Ab12.pem',
      ),
    ).toBe(false);
    expect(
      isAllowedSigningCertUrl(
        'https://sns.ap-southeast-2.amazonaws.com.evil.com/SimpleNotificationService-Ab12.pem',
      ),
    ).toBe(false);
    expect(isAllowedSigningCertUrl(`${CERT_URL}?x=1`)).toBe(false);
    expect(
      isAllowedSigningCertUrl(
        'https://s3.amazonaws.com/SimpleNotificationService-Ab12.pem',
      ),
    ).toBe(false);
  });

  it('allows ConfirmSubscription only on the SNS root', () => {
    expect(
      isAllowedSubscribeUrl(
        'https://sns.ap-southeast-2.amazonaws.com/?Action=ConfirmSubscription&Token=t',
      ),
    ).toBe(true);
    expect(
      isAllowedSubscribeUrl('https://sns.ap-southeast-2.amazonaws.com/internal'),
    ).toBe(false);
  });
});

describe('webhook secret compare', () => {
  it('matches the header value and rejects other lengths', () => {
    expect(webhookSecretMatches(SECRET, SECRET)).toBe(true);
    expect(webhookSecretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(webhookSecretMatches('short', SECRET)).toBe(false);
    expect(webhookSecretMatches(null, SECRET)).toBe(false);
  });
});

describe('SNS signature', () => {
  it('accepts a version 2 signature and rejects tampering', () => {
    const message = notification({ notificationType: 'Delivery' });
    expect(verifySnsSignature(message, certPem)).toBe(true);
    expect(verifySnsSignature({ ...message, Message: 'changed' }, certPem)).toBe(false);
    expect(verifySnsSignature({ ...message, Signature: 'bm9wZQ==' }, certPem)).toBe(
      false,
    );
    expect(verifySnsSignature(message, 'not a cert')).toBe(false);
  });

  it('accepts signature version 1', () => {
    const message = notification({ notificationType: 'Delivery' });
    const v1 = sign(message, '1');
    expect(verifySnsSignature(v1, certPem)).toBe(true);
  });

  it('includes Subject in the signed string when present', () => {
    const message = notification(
      { notificationType: 'Delivery' },
      { Subject: 'Amazon SES Email Event Notification' },
    );
    expect(verifySnsSignature(message, certPem)).toBe(true);
    const { Subject: _subject, ...withoutSubject } = message;
    expect(verifySnsSignature(withoutSubject, certPem)).toBe(false);
  });
});

describe('suppression targets', () => {
  it('keeps permanent bounces and complaints only', () => {
    const permanent: SesEvent = {
      notificationType: 'Bounce',
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'a@example.org' }, { emailAddress: '' }],
      },
    };
    expect(suppressionTargets(permanent)).toEqual([
      { address: 'a@example.org', kind: 'bounce' },
    ]);
    expect(
      suppressionTargets({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Transient',
          bouncedRecipients: [{ emailAddress: 'a@example.org' }],
        },
      }),
    ).toEqual([]);
    expect(
      suppressionTargets({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Undetermined',
          bouncedRecipients: [{ emailAddress: 'a@example.org' }],
        },
      }),
    ).toEqual([]);
    expect(
      suppressionTargets({
        notificationType: 'Complaint',
        complaint: { complainedRecipients: [{ emailAddress: 'b@example.org' }] },
      }),
    ).toEqual([{ address: 'b@example.org', kind: 'complaint' }]);
  });
});

describe('POST /api/email/events', () => {
  it('rejects a query-string secret', async () => {
    const response = await call(notification({ notificationType: 'Delivery' }), {
      path: `/api/email/events?secret=${SECRET}`,
    });
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong header secret', async () => {
    const body = notification({ notificationType: 'Delivery' });
    expect((await call(body, { secret: null })).status).toBe(403);
    expect((await call(body, { secret: 'not-the-secret-value' })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unsigned message and a bad certificate URL', async () => {
    const unsigned = notification({ notificationType: 'Delivery' });
    delete unsigned.Signature;
    expect((await call(unsigned)).status).toBe(403);

    const badCert = notification(
      { notificationType: 'Delivery' },
      { SigningCertURL: 'https://example.com/SimpleNotificationService-Ab12.pem' },
    );
    expect((await call(badCert)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  it('rejects a forged signature and the wrong topic', async () => {
    const forged = notification({ notificationType: 'Delivery' });
    forged.Signature = 'bm9wZQ==';
    expect((await call(forged)).status).toBe(403);

    const wrongTopic = notification(
      {
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [{ emailAddress: 'a@example.org' }],
        },
      },
      { TopicArn: 'arn:aws:sns:ap-southeast-2:123456789012:other-topic' },
    );
    expect((await call(wrongTopic)).status).toBe(403);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  it('returns 503 until the secret and topic are configured', async () => {
    delete process.env.EMAIL_WEBHOOK_SECRET;
    delete process.env.EMAIL_SNS_TOPIC_ARN;
    __resetEnvCache();
    const response = await call(notification({ notificationType: 'Delivery' }));
    expect(response.status).toBe(503);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  it('does not suppress a transient bounce', async () => {
    const response = await call(
      notification({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Transient',
          bouncedRecipients: [{ emailAddress: 'person@example.org' }],
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suppressed: 0 });
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  it('suppresses a permanent bounce and a complaint', async () => {
    const bounce = await call(
      notification({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [{ emailAddress: 'person@example.org' }],
        },
        mail: { messageId: 'ses-1' },
      }),
    );
    expect(bounce.status).toBe(200);
    expect(await bounce.json()).toEqual({ suppressed: 1 });
    expect(recordSuppression).toHaveBeenCalledWith({
      address: 'person@example.org',
      kind: 'bounce',
      sourceMessageId: 'ses-1',
    });

    recordSuppression.mockClear();
    const complaint = await call(
      notification({
        notificationType: 'Complaint',
        complaint: { complainedRecipients: [{ emailAddress: 'other@example.org' }] },
      }),
    );
    expect(complaint.status).toBe(200);
    expect(recordSuppression).toHaveBeenCalledWith({
      address: 'other@example.org',
      kind: 'complaint',
    });
  });

  it('confirms a signed subscription and ignores a non-SNS confirm URL', async () => {
    const subscribeURL =
      'https://sns.ap-southeast-2.amazonaws.com/?Action=ConfirmSubscription&Token=t';
    const response = await call(
      sign({
        Type: 'SubscriptionConfirmation',
        MessageId: 'mid-2',
        Token: 'token',
        TopicArn: TOPIC,
        Message: 'confirm',
        SubscribeURL: subscribeURL,
        Timestamp: '2026-10-13T00:00:00.000Z',
        SigningCertURL: CERT_URL,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ confirmed: true });
    expect(fetchMock).toHaveBeenCalledWith(
      subscribeURL,
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );

    fetchMock.mockClear();
    const rejected = await call(
      sign({
        Type: 'SubscriptionConfirmation',
        MessageId: 'mid-3',
        Token: 'token',
        TopicArn: TOPIC,
        Message: 'confirm',
        SubscribeURL: 'https://sns.ap-southeast-2.amazonaws.com/private',
        Timestamp: '2026-10-13T00:00:00.000Z',
        SigningCertURL: CERT_URL,
      }),
    );
    expect(rejected.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
