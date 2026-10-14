import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_IP_HEADER,
  ORIGIN_VERIFY_HEADER,
  clientIp,
  headersWithTrustedClientIp,
  originRequestAllowed,
} from '@/lib/http/client-ip';

const SECRET = 'origin-verify-secret-value-0123456789';
const TRUSTED_OPTIONS = { originVerifySecret: SECRET } as const;
const UNCONFIGURED = { originVerifySecret: undefined } as const;

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

function request(values: Record<string, string>): { headers: Headers } {
  return { headers: headers(values) };
}

describe('clientIp', () => {
  it('ignores a client-supplied forwarded-for chain', () => {
    expect(
      clientIp(
        request({
          'x-forwarded-for': '203.0.113.50, 198.51.100.10',
          [CLIENT_IP_HEADER]: '203.0.113.8',
        }),
        UNCONFIGURED,
      ),
    ).toBeNull();
  });

  it('ignores CF-Connecting-IP when the origin secret does not match', () => {
    expect(
      clientIp(
        request({
          'x-forwarded-for': '198.51.100.20',
          [CLIENT_IP_HEADER]: '203.0.113.8',
          [ORIGIN_VERIFY_HEADER]: `${SECRET}-nope`,
        }),
        TRUSTED_OPTIONS,
      ),
    ).toBeNull();
  });

  it('records CF-Connecting-IP only after the origin secret matches', () => {
    expect(
      clientIp(
        request({
          'x-forwarded-for': '198.51.100.20, 203.0.113.8',
          [CLIENT_IP_HEADER]: '203.0.113.8',
          [ORIGIN_VERIFY_HEADER]: SECRET,
        }),
        TRUSTED_OPTIONS,
      ),
    ).toBe('203.0.113.8');
  });

  it('does not fall back to forwarded-for when CF-Connecting-IP is not one address', () => {
    expect(
      clientIp(
        request({
          'x-forwarded-for': '203.0.113.8',
          [CLIENT_IP_HEADER]: '203.0.113.8, 198.51.100.20',
          [ORIGIN_VERIFY_HEADER]: SECRET,
        }),
        TRUSTED_OPTIONS,
      ),
    ).toBeNull();
    expect(
      clientIp(
        request({
          'x-forwarded-for': '203.0.113.8',
          [CLIENT_IP_HEADER]: 'not-an-ip',
          [ORIGIN_VERIFY_HEADER]: SECRET,
        }),
        TRUSTED_OPTIONS,
      ),
    ).toBeNull();
  });

  it('accepts a single IPv6 address from the verified origin', () => {
    expect(
      clientIp(
        request({
          [CLIENT_IP_HEADER]: '2001:db8::1',
          [ORIGIN_VERIFY_HEADER]: SECRET,
        }),
        TRUSTED_OPTIONS,
      ),
    ).toBe('2001:db8::1');
  });
});

describe('headersWithTrustedClientIp', () => {
  it('removes forwarded headers and keeps only the verified address', async () => {
    const body = JSON.stringify({ email: 'person@example.org' });
    const incoming = new Request('https://app.example/api/auth/sign-in/email', {
      method: 'POST',
      headers: headers({
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.20',
        'x-real-ip': '198.51.100.21',
        [CLIENT_IP_HEADER]: '203.0.113.8',
        [ORIGIN_VERIFY_HEADER]: SECRET,
      }),
      body,
    });

    const rewritten = new Request(incoming, {
      headers: headersWithTrustedClientIp(incoming.headers, TRUSTED_OPTIONS),
    });

    expect(rewritten.headers.get('x-forwarded-for')).toBeNull();
    expect(rewritten.headers.get('x-real-ip')).toBeNull();
    expect(rewritten.headers.get(ORIGIN_VERIFY_HEADER)).toBeNull();
    expect(rewritten.headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.8');
    expect(rewritten.headers.get('content-type')).toBe('application/json');
    expect(await rewritten.text()).toBe(body);
  });

  it('drops CF-Connecting-IP when the origin is not verified', () => {
    const source = headers({
      'x-forwarded-for': '198.51.100.20',
      [CLIENT_IP_HEADER]: '203.0.113.8',
    });
    const sanitized = headersWithTrustedClientIp(source, UNCONFIGURED);
    expect(sanitized.get('x-forwarded-for')).toBeNull();
    expect(sanitized.get(CLIENT_IP_HEADER)).toBeNull();
  });
});

describe('originRequestAllowed', () => {
  it('refuses production traffic that lacks the origin secret', () => {
    expect(
      originRequestAllowed({
        pathname: '/api/auth/sign-in/email',
        headers: headers({
          'x-forwarded-for': '203.0.113.8',
          [CLIENT_IP_HEADER]: '203.0.113.8',
        }),
        nodeEnv: 'production',
        originVerifySecret: SECRET,
      }),
    ).toBe(false);
    expect(
      originRequestAllowed({
        pathname: '/',
        headers: headers({}),
        nodeEnv: 'production',
        originVerifySecret: undefined,
      }),
    ).toBe(false);
  });

  it('allows a production request that presents the origin secret', () => {
    expect(
      originRequestAllowed({
        pathname: '/dashboard',
        headers: headers({ [ORIGIN_VERIFY_HEADER]: SECRET }),
        nodeEnv: 'production',
        originVerifySecret: SECRET,
      }),
    ).toBe(true);
  });

  it('keeps probes and non-production requests open', () => {
    for (const pathname of ['/api/health', '/api/ready/', '/api/live']) {
      expect(
        originRequestAllowed({
          pathname,
          headers: headers({}),
          nodeEnv: 'production',
          originVerifySecret: SECRET,
        }),
      ).toBe(true);
    }
    expect(
      originRequestAllowed({
        pathname: '/sign-in',
        headers: headers({}),
        nodeEnv: 'development',
        originVerifySecret: undefined,
      }),
    ).toBe(true);
  });
});

describe('client address reads', () => {
  it('keeps forwarded-for handling inside the one helper', () => {
    const root = join(import.meta.dirname, '../../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue;
        const text = readFileSync(path, 'utf8');
        if (!/x-forwarded-for/i.test(text)) continue;
        if (!path.endsWith('src/lib/http/client-ip.ts')) offenders.push(path);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
