import { isProduction } from '@/lib/env';

/**
 * Client address for request limits.
 *
 * Production trusts only `cf-connecting-ip`. The load balancer accepts
 * Cloudflare ranges and nothing else (`infra/k8s/service-ingress.yaml`
 * inbound-cidrs), so that header is the client. A list, or a missing header,
 * becomes the shared identity `unknown` — one strict bucket, not a bypass.
 *
 * `x-forwarded-for` is never read here. Outside production a single
 * `x-real-ip` is accepted so local runs can still separate clients.
 */

export const UNKNOWN_CLIENT_IP = 'unknown';

function isSingleIp(value: string): boolean {
  if (value.length < 3 || value.length > 45) return false;
  if (/[\s,]/.test(value)) return false;
  if (value.includes(':')) return /^[0-9a-fA-F:]+$/.test(value);
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function clientIp(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip')?.trim() ?? '';
  if (isSingleIp(cf)) return cf;
  if (!isProduction()) {
    const real = headers.get('x-real-ip')?.trim() ?? '';
    if (isSingleIp(real)) return real;
  }
  return UNKNOWN_CLIENT_IP;
}
