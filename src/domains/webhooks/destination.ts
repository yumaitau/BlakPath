import type { LookupAddress, LookupOptions } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { env } from '@/lib/env';

/**
 * Outbound webhook destination policy.
 *
 * Registration and every delivery must refuse hosts that are not public HTTPS
 * endpoints. The check runs again inside the connect lookup, on the addresses
 * returned at that moment, so a name that changed after registration cannot
 * be dialled. Redirects are not a concern of this module; the dispatcher
 * refuses to follow them.
 */

/** Suffixes that are never a public webhook target. Matched on the full label. */
const BLOCKED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'svc.cluster.local',
  'cluster.local',
];

const baseBlockList = new BlockList();

function deny4(address: string, prefix: number): void {
  baseBlockList.addSubnet(address, prefix, 'ipv4');
}
function deny6(address: string, prefix: number): void {
  baseBlockList.addSubnet(address, prefix, 'ipv6');
}

// Private, loopback, link-local, CGNAT, and unique-local ranges, plus the
// non-global ranges that are routinely used to reach those same networks.
deny4('0.0.0.0', 8);
deny4('10.0.0.0', 8);
deny4('100.64.0.0', 10);
deny4('127.0.0.0', 8);
deny4('169.254.0.0', 16);
deny4('172.16.0.0', 12);
deny4('192.168.0.0', 16);
deny4('224.0.0.0', 4);
deny4('240.0.0.0', 4);
deny6('::', 96);
// IPv4-mapped IPv6 (::ffff:0:0/96) is intentionally absent. Node applies the
// IPv4 rules above to those addresses, so private mapped forms stay blocked.
// Adding the prefix here makes BlockList.check treat every IPv4 address as
// blocked (it stores the range as ::ffff:0.0.0.0/96).
deny6('64:ff9b::', 96);
deny6('2002::', 16);
deny6('fc00::', 7);
deny6('fd00::', 8);
deny6('fe80::', 10);
deny6('fec0::', 10);
deny6('ff00::', 8);

let extraCache: { raw: string; list: BlockList } | null = null;

export class WebhookDestinationError extends Error {
  readonly code = 'WEBHOOK_DESTINATION_REJECTED' as const;
  constructor() {
    super('webhook destination rejected');
    this.name = 'WebhookDestinationError';
  }
}

/** DNS failed in a way that may succeed on a later attempt. */
export class WebhookDnsError extends Error {
  readonly code = 'WEBHOOK_DNS_TRANSIENT' as const;
  constructor() {
    super('webhook dns lookup failed');
    this.name = 'WebhookDnsError';
  }
}

export type HostResolver = (hostname: string) => Promise<string[]>;

export function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function extraBlockList(): BlockList | null {
  const raw = env.WEBHOOK_DENY_CIDRS?.trim() ?? '';
  if (!raw) return null;
  if (extraCache?.raw === raw) return extraCache.list;
  const list = new BlockList();
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const slash = item.lastIndexOf('/');
    const address = slash > 0 ? item.slice(0, slash) : '';
    const prefix = Number(item.slice(slash + 1));
    const family = isIP(address);
    const max = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (
      slash <= 0 ||
      max < 0 ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > max
    ) {
      throw new WebhookDestinationError();
    }
    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  extraCache = { raw, list };
  return list;
}

/** True when an address is not a global unicast target we are willing to dial. */
export function isBlockedIp(address: string): boolean {
  const ip = normalizeHost(address);
  const family = isIP(ip);
  if (family !== 4 && family !== 6) return true;
  const kind = family === 4 ? 'ipv4' : 'ipv6';
  if (baseBlockList.check(ip, kind)) return true;
  const extra = extraBlockList();
  return extra ? extra.check(ip, kind) : false;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host || isIP(host)) return false;
  return BLOCKED_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/**
 * Synchronous URL policy: HTTPS, no userinfo, no blocked name or literal.
 * Hostnames that still need a DNS answer are left for `assertWebhookDestination`.
 * Returns a client-safe message, or null when the URL may proceed to DNS.
 */
export function webhookUrlIssue(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'URL must be HTTPS.';
  }
  if (url.protocol !== 'https:') return 'URL must be HTTPS.';
  if (url.username !== '' || url.password !== '') {
    return 'URL must be a public HTTPS endpoint.';
  }
  const host = normalizeHost(url.hostname);
  if (!host) return 'URL must be a public HTTPS endpoint.';
  if (isIP(host)) {
    return isBlockedIp(host) ? 'URL must be a public HTTPS endpoint.' : null;
  }
  if (isBlockedHostname(host) || !host.includes('.')) {
    return 'URL must be a public HTTPS endpoint.';
  }
  return null;
}

const resolver = new Resolver();

function dnsCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return '';
}

async function resolveOne(kind: 'A' | 'AAAA', hostname: string): Promise<string[]> {
  try {
    return kind === 'A'
      ? await resolver.resolve4(hostname)
      : await resolver.resolve6(hostname);
  } catch (err) {
    const code = dnsCode(err);
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ENOENT') return [];
    throw new WebhookDnsError();
  }
}

/** Absolute DNS answers only. Search domains and the hosts file are not consulted. */
export async function resolveWebhookHost(hostname: string): Promise<string[]> {
  const fqdn = hostname.endsWith('.') ? hostname : `${hostname}.`;
  const [v4, v6] = await Promise.all([resolveOne('A', fqdn), resolveOne('AAAA', fqdn)]);
  return [...v4, ...v6];
}

/**
 * Addresses we are willing to open a socket to. Any private or non-global
 * answer rejects the whole name. Empty answers are a hard refusal.
 */
export async function resolveWebhookAddresses(
  hostname: string,
  resolve: HostResolver = resolveWebhookHost,
): Promise<string[]> {
  const host = normalizeHost(hostname);
  if (!host || isBlockedHostname(host)) throw new WebhookDestinationError();
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new WebhookDestinationError();
    return [host];
  }
  if (!host.includes('.')) throw new WebhookDestinationError();

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    if (err instanceof WebhookDestinationError || err instanceof WebhookDnsError)
      throw err;
    throw new WebhookDnsError();
  }
  const normalised = addresses.map((address) => normalizeHost(address));
  if (normalised.length === 0 || normalised.some((address) => isBlockedIp(address))) {
    throw new WebhookDestinationError();
  }
  return normalised;
}

export async function assertWebhookDestination(
  rawUrl: string,
  resolve: HostResolver = resolveWebhookHost,
): Promise<void> {
  if (webhookUrlIssue(rawUrl)) throw new WebhookDestinationError();
  const host = normalizeHost(new URL(rawUrl).hostname);
  if (isIP(host)) return;
  await resolveWebhookAddresses(host, resolve);
}

/** Create-time gate. Any lookup failure refuses the endpoint; nothing is stored. */
export async function assertWebhookDestinationForCreate(
  rawUrl: string,
  resolve?: HostResolver,
): Promise<void> {
  try {
    await assertWebhookDestination(rawUrl, resolve);
  } catch (err) {
    if (err instanceof WebhookDestinationError) throw err;
    throw new WebhookDestinationError();
  }
}

function preferIpv4(addresses: string[]): string {
  return addresses.find((address) => isIP(address) === 4) ?? addresses[0] ?? '';
}

/**
 * `net`/`tls` lookup used by the delivery dispatcher. It resolves at connect
 * time and returns one already-checked address, so the socket is not dialled
 * from a later answer.
 */
export type WebhookLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

export function createWebhookLookup(
  resolve: HostResolver = resolveWebhookHost,
): WebhookLookup {
  const lookup: WebhookLookup = (hostname, options, callback) => {
    void resolveWebhookAddresses(hostname, resolve)
      .then((addresses) => {
        const all = typeof options === 'object' && options.all === true;
        if (all) {
          callback(
            null,
            addresses.map((address) => ({
              address,
              family: isIP(address) as 4 | 6,
            })),
          );
          return;
        }
        const chosen = preferIpv4(addresses);
        const family = isIP(chosen);
        if (family !== 4 && family !== 6) {
          callback(new WebhookDestinationError(), '', 4);
          return;
        }
        callback(null, chosen, family);
      })
      .catch((err: unknown) => {
        const error = (
          err instanceof Error ? err : new WebhookDestinationError()
        ) as NodeJS.ErrnoException;
        if (!(err instanceof WebhookDnsError)) {
          error.code = 'WEBHOOK_DESTINATION_REJECTED';
        }
        callback(error, '', 4);
      });
  };
  return lookup;
}

export function isDestinationRejection(err: unknown): boolean {
  const seen = new Set<unknown>();
  const pending = [err];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof WebhookDestinationError) return true;
    if (typeof current === 'object') {
      const record = current as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
        errors?: unknown;
      };
      if (record.code === 'WEBHOOK_DESTINATION_REJECTED') return true;
      if (record.message === 'webhook destination rejected') return true;
      if ('cause' in record) pending.push(record.cause);
      if (Array.isArray(record.errors)) pending.push(...record.errors);
    }
  }
  return false;
}
