import { Agent, fetch as undiciFetch } from 'undici';
import {
  assertWebhookDestination,
  createWebhookLookup,
  type HostResolver,
} from './destination';

/**
 * Signed webhook POST.
 *
 * The destination is checked before the call and again inside the connect
 * lookup. `redirect: 'manual'` keeps a 3xx on the first response; the Location
 * is never requested.
 */

const TIMEOUT_MS = 10_000;

export type DeliveryDisposition = 'delivered' | 'redirect' | 'retry';

export function deliveryDisposition(status: number): DeliveryDisposition {
  if (status >= 200 && status < 300) return 'delivered';
  if (status >= 300 && status < 400) return 'redirect';
  return 'retry';
}

let sharedAgent: Agent | undefined;

export function webhookAgent(): Agent {
  if (!sharedAgent) {
    sharedAgent = new Agent({
      connect: { lookup: createWebhookLookup() },
      connectTimeout: TIMEOUT_MS,
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
  }
  return sharedAgent;
}

export interface WebhookRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: 'manual';
  dispatcher?: Agent;
}

interface WebhookResponse {
  status: number;
  body?: { cancel: () => Promise<void> } | null;
}

export interface WebhookTransport {
  resolve?: HostResolver;
  fetch?: (url: string, init: WebhookRequestInit) => Promise<WebhookResponse>;
}

async function defaultWebhookFetch(
  url: string,
  init: WebhookRequestInit,
): Promise<WebhookResponse> {
  return undiciFetch(url, { ...init, dispatcher: webhookAgent() });
}

export async function deliverWebhookRequest(
  url: string,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  transport?: WebhookTransport,
): Promise<{ status: number }> {
  await assertWebhookDestination(url, transport?.resolve);
  const fetchImpl = transport?.fetch ?? defaultWebhookFetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
    signal,
    redirect: 'manual',
  });
  if (response.body) {
    try {
      await response.body.cancel();
    } catch {
      // The status is already known. A cancel failure must not hide it.
    }
  }
  return { status: response.status };
}
