import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { env } from '@/lib/env';

/**
 * Client address for audit records and rate-limit identity.
 *
 * `CF-Connecting-IP` is recorded only when the request presents the configured
 * origin-verify secret. That secret is added by our Cloudflare zone on the
 * request to the origin; a caller who can reach the process directly cannot
 * satisfy it. `X-Forwarded-For` and other forwarded address headers are never
 * a client identity.
 */

export const ORIGIN_VERIFY_HEADER = 'x-blakpath-origin-verify';
export const CLIENT_IP_HEADER = 'cf-connecting-ip';

/** Process probes. They are not application traffic and carry no client identity. */
export const ORIGIN_PROBE_PATHS = ['/api/health', '/api/ready', '/api/live'] as const;

const SPOOFABLE_IP_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'true-client-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
] as const;

const MAX_SECRET_CHARS = 256;
const MAX_IP_CHARS = 64;

export type ClientIpSource = {
  headers: { get(name: string): string | null };
};

export type ClientIpOptions = {
  readonly originVerifySecret: string | undefined;
};

function originSecretMatches(
  provided: string | null,
  expected: string | undefined,
): boolean {
  if (!provided || !expected) return false;
  if (provided.length > MAX_SECRET_CHARS || expected.length > MAX_SECRET_CHARS)
    return false;
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function canonicalIp(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IP_CHARS) return null;
  if (isIP(trimmed) === 0) return null;
  return trimmed;
}

function configuredSecret(options: ClientIpOptions | undefined): string | undefined {
  return options ? options.originVerifySecret : env.ORIGIN_VERIFY_SECRET;
}

/** Address to store for this request, or null when the origin is not verified. */
export function clientIp(
  request: ClientIpSource,
  options?: ClientIpOptions,
): string | null {
  if (
    !originSecretMatches(
      request.headers.get(ORIGIN_VERIFY_HEADER),
      configuredSecret(options),
    )
  ) {
    return null;
  }
  return canonicalIp(request.headers.get(CLIENT_IP_HEADER));
}

/**
 * Copy of `source` safe to hand to Better Auth.
 *
 * Forwarded address headers are removed. `CF-Connecting-IP` is set only to the
 * value `clientIp` accepted, so rate limits and session addresses cannot follow
 * a client-supplied chain. The origin-verify secret is removed as well.
 */
export function headersWithTrustedClientIp(
  source: Headers,
  options?: ClientIpOptions,
): Headers {
  const ip = clientIp({ headers: source }, options);
  const headers = new Headers(source);
  for (const name of SPOOFABLE_IP_HEADERS) headers.delete(name);
  headers.delete(ORIGIN_VERIFY_HEADER);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  return headers;
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/**
 * Production requests must present the origin-verify secret. Probes stay open
 * so the kubelet and the load balancer can reach the process directly. Other
 * environments stay open so local development and CI are not gated on Cloudflare.
 */
export function originRequestAllowed(input: {
  pathname: string;
  headers: { get(name: string): string | null };
  nodeEnv: string;
  originVerifySecret: string | undefined;
}): boolean {
  if ((ORIGIN_PROBE_PATHS as readonly string[]).includes(normalizePath(input.pathname))) {
    return true;
  }
  if (input.nodeEnv !== 'production') return true;
  return originSecretMatches(
    input.headers.get(ORIGIN_VERIFY_HEADER),
    input.originVerifySecret,
  );
}

/**
 * Cloudflare-only headers. `x-forwarded-for` is not one: the Next.js server
 * adds it to every request, including kubelet probes, and the ALB strips it.
 */
const EDGE_FORWARDING_HEADERS = ['cf-connecting-ip', 'cf-ray'] as const;

/**
 * True when the request carries a non-empty Cloudflare edge header. This is a
 * route signal (the request came through Cloudflare), never a client
 * identity. Kubelet probes and in-VPC calls to the pod carry none.
 */
export function arrivedThroughEdge(headers: {
  get(name: string): string | null;
}): boolean {
  for (const name of EDGE_FORWARDING_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value.trim() !== '') return true;
  }
  return false;
}

/** Shared rate-limit identity when the origin has not been verified. */
export const UNKNOWN_CLIENT_IP = 'unknown';

/**
 * Address bucket for request limits. A missing or unverified origin shares one
 * strict bucket instead of skipping the limit.
 */
export function clientIpForLimits(headers: Headers): string {
  return clientIp({ headers }) ?? UNKNOWN_CLIENT_IP;
}
