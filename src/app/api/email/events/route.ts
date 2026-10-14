import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { clientIpForLimits } from '@/lib/http/client-ip';
import { REQUEST_LIMITS, limitIp, limitSubject } from '@/lib/http/request-limits';
import { logger } from '@/lib/observability/logger';
import {
  isAllowedSigningCertUrl,
  isAllowedSubscribeUrl,
  verifySnsSignature,
  webhookSecretMatches,
  type SnsEnvelope,
} from '@/lib/email/sns';
import { recordSuppression } from '@/domains/email';
import { parseSesEvent, suppressionTargets } from '@/domains/email/events';

/**
 * POST /api/email/events — SES bounce/complaint events via SNS.
 *
 * Authentication is the SNS message signature (certificate from
 * `sns.<region>.amazonaws.com`) plus an exact `TopicArn` match against
 * `EMAIL_SNS_TOPIC_ARN`. The shared secret is accepted only from the
 * `x-email-webhook-secret` header, compared in constant time. A `secret`
 * query parameter is rejected. No session. Never logs addresses or bodies.
 *
 * SNS HTTPS delivery cannot attach that header. A forwarder in front of this
 * route must add it. Subscription confirmation URLs are fetched only after
 * the signature check and only when the host is SNS.
 */

export const runtime = 'nodejs';

const snsEnvelope = z.object({
  Type: z.string(),
  MessageId: z.string().nullish(),
  Token: z.string().nullish(),
  TopicArn: z.string().nullish(),
  Message: z.string().nullish(),
  SubscribeURL: z.string().nullish(),
  Timestamp: z.string().nullish(),
  SignatureVersion: z.string().nullish(),
  Signature: z.string().nullish(),
  SigningCertURL: z.string().nullish(),
  Subject: z.string().nullish(),
});

function forbidden(): Response {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

async function loadSigningCert(url: string): Promise<string | null> {
  if (!isAllowedSigningCertUrl(url)) return null;
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const pem = await response.text();
    if (pem.length === 0 || pem.length > 20_000 || !pem.includes('BEGIN CERTIFICATE')) {
      return null;
    }
    return pem;
  } catch (error) {
    logger.error({ err: error }, 'email events signing certificate unavailable');
    return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const ipLimited = await limitIp(
    REQUEST_LIMITS.emailEvents,
    clientIpForLimits(request.headers),
  );
  if (ipLimited) return ipLimited;
  const headerSecret = request.headers.get('x-email-webhook-secret');
  if (headerSecret) {
    const secretLimited = await limitSubject(REQUEST_LIMITS.emailEvents, headerSecret);
    if (secretLimited) return secretLimited;
  }

  const secret = env.EMAIL_WEBHOOK_SECRET;
  const topicArn = env.EMAIL_SNS_TOPIC_ARN;
  if (!secret || !topicArn) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  if (url.searchParams.has('secret')) {
    logger.warn({ reason: 'query' }, 'email events rejected');
    return forbidden();
  }
  if (!webhookSecretMatches(request.headers.get('x-email-webhook-secret'), secret)) {
    return forbidden();
  }

  let envelope: SnsEnvelope;
  try {
    envelope = snsEnvelope.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const certUrl = envelope.SigningCertURL;
  if (!envelope.Signature || !certUrl) return forbidden();
  const pem = await loadSigningCert(certUrl);
  if (!pem || !verifySnsSignature(envelope, pem)) {
    logger.warn({ reason: 'signature' }, 'email events rejected');
    return forbidden();
  }
  if (envelope.TopicArn !== topicArn) {
    logger.warn({ reason: 'topic' }, 'email events rejected');
    return forbidden();
  }

  if (envelope.Type === 'SubscriptionConfirmation' && envelope.SubscribeURL) {
    if (!isAllowedSubscribeUrl(envelope.SubscribeURL)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    try {
      await fetch(envelope.SubscribeURL, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      logger.error({ err: error }, 'email events subscription confirm failed');
      return NextResponse.json({ error: 'Upstream unavailable' }, { status: 502 });
    }
    logger.info('email events subscription confirmed');
    return NextResponse.json({ confirmed: true });
  }

  if (envelope.Type !== 'Notification' || !envelope.Message) {
    return NextResponse.json({ received: true });
  }

  const message = parseSesEvent(envelope.Message);
  if (!message) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  if (message.notificationType !== 'Bounce' && message.notificationType !== 'Complaint') {
    return NextResponse.json({ received: true });
  }

  const targets = suppressionTargets(message);
  for (const target of targets) {
    try {
      await recordSuppression({
        address: target.address,
        kind: target.kind,
        ...(message.mail?.messageId ? { sourceMessageId: message.mail.messageId } : {}),
      });
    } catch (error) {
      logger.error({ err: error }, 'failed to record email suppression');
    }
  }
  logger.info({ count: targets.length }, 'email suppressions recorded');
  return NextResponse.json({ suppressed: targets.length });
}
