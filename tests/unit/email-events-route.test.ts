import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * Only permanent bounces and complaints suppress an address; transient and
 * undetermined bounces must not silently stop a member's mail.
 */

const recordSuppression = vi.hoisted(() => vi.fn(async () => ({ suppressed: true })));
vi.mock('@/domains/email', () => ({ recordSuppression }));
vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: { EMAIL_WEBHOOK_SECRET: 'test-webhook-secret-123456', LOG_LEVEL: 'silent' },
}));

const { POST } = await import('@/app/api/email/events/route');

function snsBounce(bounceType: string): NextRequest {
  const message = {
    notificationType: 'Bounce',
    mail: { messageId: 'm-1' },
    bounce: {
      bounceType,
      bouncedRecipients: [{ emailAddress: 'sam@example.org' }],
    },
  };
  return new Request('https://app.test/api/email/events', {
    method: 'POST',
    headers: { 'x-email-webhook-secret': 'test-webhook-secret-123456' },
    body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify(message) }),
  }) as unknown as NextRequest;
}

beforeEach(() => recordSuppression.mockClear());

describe('POST /api/email/events', () => {
  it('suppresses on a permanent bounce', async () => {
    const response = await POST(snsBounce('Permanent'));
    expect(await response.json()).toEqual({ suppressed: 1 });
    expect(recordSuppression).toHaveBeenCalledWith({
      address: 'sam@example.org',
      kind: 'bounce',
      sourceMessageId: 'm-1',
    });
  });

  it.each(['Transient', 'Undetermined'])('ignores a %s bounce', async (type) => {
    const response = await POST(snsBounce(type));
    expect(await response.json()).toEqual({ received: true });
    expect(recordSuppression).not.toHaveBeenCalled();
  });
});
