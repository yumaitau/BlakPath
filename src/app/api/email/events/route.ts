import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { clientIpForLimits } from '@/lib/http/client-ip';
import { REQUEST_LIMITS, limitIp, limitSubject } from '@/lib/http/request-limits';
import { currentRequestIds } from '@/lib/observability/correlation';
import { logger } from '@/lib/observability/logger';
import { ClientSafeError, sanitiseError, tenantHandler } from '@/lib/http/error-response';
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
 * Production source: the SES configuration set (SES_CONFIGURATION_SET) event
 * destination → SNS topic → this route. Only permanent bounces and complaints
 * suppress (see `parseSesEvent`).
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
    logger.error(
      { err: sanitiseError(error), requestId: currentRequestIds()?.requestId },
      'email events signing certificate unavailable',
    );
    return null;
  }
}

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
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
    throw new ClientSafeError(503, 'NOT_CONFIGURED', 'Not configured');
  }

  const url = new URL(request.url);
  if (url.searchParams.has('secret')) {
    logger.warn({ reason: 'query' }, 'email events rejected');
    return forbidden();
  }
  if (!webhookSecretMatches(request.headers.get('x-email-webhook-secret'), secret)) {
    return forbidden();
  }

  // Malformed JSON (SyntaxError) and a bad envelope (ZodError) map to 400.
  const envelope: SnsEnvelope = snsEnvelope.parse(await request.json());

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
      throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Invalid request');
    }
    try {
      await fetch(envelope.SubscribeURL, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      logger.error(
        { err: sanitiseError(error), requestId: currentRequestIds()?.requestId },
        'email events subscription confirm failed',
      );
      throw new ClientSafeError(502, 'UPSTREAM_UNAVAILABLE', 'Upstream unavailable');
    }
    logger.info('email events subscription confirmed');
    return NextResponse.json({ confirmed: true });
  }

  if (envelope.Type !== 'Notification' || !envelope.Message) {
    return NextResponse.json({ received: true });
  }

  const message = parseSesEvent(envelope.Message);
  if (!message) throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Invalid request');

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
      logger.error(
        { err: sanitiseError(error), requestId: currentRequestIds()?.requestId },
        'failed to record email suppression',
      );
    }
  }
  logger.info({ count: targets.length }, 'email suppressions recorded');
  return NextResponse.json({ suppressed: targets.length });
});
