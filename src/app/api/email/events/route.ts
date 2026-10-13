import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { currentRequestIds } from '@/lib/observability/correlation';
import { logger } from '@/lib/observability/logger';
import { recordSuppression } from '@/domains/email';
import { ClientSafeError, sanitiseError, tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/email/events — SES bounce/complaint events via SNS.
 *
 * Gated by shared secret (`?secret=` or `x-email-webhook-secret`), matching
 * EMAIL_WEBHOOK_SECRET. SubscriptionConfirmation URLs are only fetched when
 * the hostname is a genuine SNS endpoint (SSRF guard). No auth session needed;
 * the secret is the credential. Never logs addresses or message bodies.
 */

const snsEnvelope = z.object({
  Type: z.string(),
  Message: z.string().optional(),
  SubscribeURL: z.string().url().optional(),
  TopicArn: z.string().optional(),
});

const sesMessage = z.object({
  notificationType: z.string(),
  mail: z.object({ messageId: z.string().optional() }).optional(),
  bounce: z
    .object({
      bouncedRecipients: z.array(z.object({ emailAddress: z.string() })).optional(),
    })
    .optional(),
  complaint: z
    .object({
      complainedRecipients: z.array(z.object({ emailAddress: z.string() })).optional(),
    })
    .optional(),
});

function snsHostOk(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(host);
  } catch {
    return false;
  }
}

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const secret = env.EMAIL_WEBHOOK_SECRET;
  if (!secret) throw new ClientSafeError(503, 'NOT_CONFIGURED', 'Not configured');
  const url = new URL(request.url);
  const provided =
    url.searchParams.get('secret') ?? request.headers.get('x-email-webhook-secret');
  if (provided !== secret) throw new ClientSafeError(403, 'FORBIDDEN', 'Forbidden');

  const envelope = snsEnvelope.parse(await request.json());

  if (envelope.Type === 'SubscriptionConfirmation' && envelope.SubscribeURL) {
    if (!snsHostOk(envelope.SubscribeURL)) {
      throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Invalid request');
    }
    await fetch(envelope.SubscribeURL, { method: 'GET' });
    logger.info({ topic: envelope.TopicArn }, 'email events subscription confirmed');
    return NextResponse.json({ confirmed: true });
  }

  if (envelope.Type !== 'Notification' || !envelope.Message) {
    return NextResponse.json({ received: true });
  }

  const message = sesMessage.parse(JSON.parse(envelope.Message));

  const targets: { address: string; kind: 'bounce' | 'complaint' }[] = [];
  if (message.notificationType === 'Bounce') {
    for (const r of message.bounce?.bouncedRecipients ?? []) {
      targets.push({ address: r.emailAddress, kind: 'bounce' });
    }
  } else if (message.notificationType === 'Complaint') {
    for (const r of message.complaint?.complainedRecipients ?? []) {
      targets.push({ address: r.emailAddress, kind: 'complaint' });
    }
  } else {
    return NextResponse.json({ received: true });
  }

  for (const t of targets) {
    try {
      await recordSuppression({
        address: t.address,
        kind: t.kind,
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
