import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Worker-side delivery against an in-memory tenant store: simulates BullMQ
 * driving retries on the webhook schedule while a receiver is unreachable.
 */

const state = vi.hoisted(() => ({
  delivery: null as Record<string, unknown> | null,
  endpoint: null as Record<string, unknown> | null,
  audits: [] as Array<{ action: string }>,
}));

vi.mock('@/db/tenant-db', async () => {
  const schema = await import('@/db/schema');
  function select() {
    let table: unknown;
    const chain: Record<string, unknown> = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      where: () => chain,
      limit: () => {
        const row = table === schema.webhookDeliveries ? state.delivery : state.endpoint;
        return Promise.resolve(row ? [{ ...row }] : []);
      },
    };
    return chain;
  }
  function update() {
    let patch: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      set(p: Record<string, unknown>) {
        patch = p;
        return chain;
      },
      where() {
        state.delivery = { ...state.delivery, ...patch };
        return Promise.resolve([]);
      },
    };
    return chain;
  }
  return { scopeFor: () => ({ db: { select, update } }) };
});

vi.mock('@/domains/audit/service', () => ({
  recordAudit: vi.fn(async (input: { action: string }) => {
    state.audits.push(input);
  }),
}));

vi.mock('@/lib/observability/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { processWebhookDelivery, verifyPayload, webhookAttemptOffsetMs, MAX_ATTEMPTS } =
  await import('@/domains/webhooks');

const HOUR = 3_600_000;
const SECRET = 'endpoint-signing-secret';

beforeEach(() => {
  state.audits = [];
  state.endpoint = {
    id: 'endpoint-1',
    url: 'https://receiver.example/hook',
    secret: SECRET,
    active: true,
    deletedAt: null,
  };
  state.delivery = {
    id: 'delivery-1',
    endpointId: 'endpoint-1',
    event: 'certificate.revoked',
    payload: { certificateId: 'cert-1', reference: 'COA-1', applicationId: 'app-1' },
    status: 'pending',
    attempts: 0,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processWebhookDelivery', () => {
  it('delivers a signed event to a receiver that was down for an hour', async () => {
    const received: Array<{ body: string; headers: Record<string, string> }> = [];
    let clock = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: { body: string; headers: Record<string, string> }) => {
          if (clock < HOUR) throw new Error('connect ECONNREFUSED');
          received.push({ body: init.body, headers: init.headers });
          return new Response(null, { status: 204 });
        },
      ),
    );

    // Drive attempts as BullMQ would: each failure throws, the next attempt
    // runs after the webhook backoff.
    let attempt = 1;
    for (; attempt <= MAX_ATTEMPTS; attempt += 1) {
      clock = webhookAttemptOffsetMs(attempt);
      try {
        await processWebhookDelivery({
          organisationId: 'org-a',
          deliveryId: 'delivery-1',
          correlationId: 'corr-1',
        });
        break;
      } catch {
        expect(state.delivery?.status).toBe('pending');
      }
    }

    expect(state.delivery?.status).toBe('delivered');
    expect(clock).toBeGreaterThanOrEqual(HOUR);
    expect(received).toHaveLength(1);
    const [{ body, headers }] = received as [(typeof received)[number]];
    expect(headers['x-blakpath-event']).toBe('certificate.revoked');
    expect(verifyPayload(SECRET, body, headers['x-blakpath-signature'] ?? '')).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      id: 'delivery-1',
      event: 'certificate.revoked',
      payload: { certificateId: 'cert-1' },
    });
    expect(state.audits.at(-1)?.action).toBe('integration.call_succeeded');
  });

  it('marks the delivery failed (no throw) once the attempt budget is spent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    state.delivery = { ...state.delivery, attempts: MAX_ATTEMPTS - 1 };
    await processWebhookDelivery({
      organisationId: 'org-a',
      deliveryId: 'delivery-1',
      correlationId: 'corr-1',
    });
    expect(state.delivery?.status).toBe('failed');
    expect(state.delivery?.attempts).toBe(MAX_ATTEMPTS);
  });
});
