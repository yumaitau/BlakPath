import { describe, expect, it } from 'vitest';
import {
  deliverWebhookRequest,
  deliveryDisposition,
  type WebhookRequestInit,
} from '@/domains/webhooks/dispatch';

describe('webhook dispatch', () => {
  it('classifies success, redirects and other status codes', () => {
    expect(deliveryDisposition(200)).toBe('delivered');
    expect(deliveryDisposition(204)).toBe('delivered');
    expect(deliveryDisposition(301)).toBe('redirect');
    expect(deliveryDisposition(302)).toBe('redirect');
    expect(deliveryDisposition(307)).toBe('redirect');
    expect(deliveryDisposition(404)).toBe('retry');
    expect(deliveryDisposition(500)).toBe('retry');
  });

  it('does not follow a 3xx and asks the transport not to', async () => {
    const calls: WebhookRequestInit[] = [];
    let cancelled = false;
    const result = await deliverWebhookRequest(
      'https://hooks.example/hook',
      '{"ok":true}',
      { 'content-type': 'application/json' },
      new AbortController().signal,
      {
        resolve: async () => ['1.1.1.1'],
        fetch: async (_url, init) => {
          calls.push(init);
          return {
            status: 302,
            body: {
              cancel: async () => {
                cancelled = true;
              },
            },
          };
        },
      },
    );

    expect(result.status).toBe(302);
    expect(cancelled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe('manual');
    expect(calls[0]?.method).toBe('POST');
  });
});
