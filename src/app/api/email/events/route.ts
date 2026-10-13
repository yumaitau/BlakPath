import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import { recordSuppression } from '@/domains/email';
import { parseSesEvent } from '@/lib/email/ses-events';

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

function snsHostOk(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(host);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const secret = env.EMAIL_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  const url = new URL(request.url);
  const provided =
    url.searchParams.get('secret') ?? request.headers.get('x-email-webhook-secret');
  if (provided !== secret) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let envelope: z.infer<typeof snsEnvelope>;
  try {
    envelope = snsEnvelope.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  if (envelope.Type === 'SubscriptionConfirmation' && envelope.SubscribeURL) {
    if (!snsHostOk(envelope.SubscribeURL)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    await fetch(envelope.SubscribeURL, { method: 'GET' });
    logger.info({ topic: envelope.TopicArn }, 'email events subscription confirmed');
    return NextResponse.json({ confirmed: true });
  }

  if (envelope.Type !== 'Notification' || !envelope.Message) {
    return NextResponse.json({ received: true });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(envelope.Message);
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const parsed = parseSesEvent(payload);
  if (parsed.status === 'invalid') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (parsed.status === 'ignored') {
    return NextResponse.json({ received: true });
  }

  for (const target of parsed.targets) {
    try {
      await recordSuppression({
        address: target.address,
        kind: target.kind,
        ...(target.sourceMessageId ? { sourceMessageId: target.sourceMessageId } : {}),
      });
    } catch (error) {
      logger.error({ err: error }, 'failed to record email suppression');
    }
  }
  logger.info({ count: parsed.targets.length }, 'email suppressions recorded');
  return NextResponse.json({ suppressed: parsed.targets.length });
}
