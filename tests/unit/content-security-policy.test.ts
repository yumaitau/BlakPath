import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  createNonce,
  CSP_REPORT_PATH,
} from '@/lib/http/content-security-policy';

function directive(policy: string, name: string): string {
  const match = policy.split(';').find((part) => part.trim().startsWith(`${name} `));
  return match?.trim() ?? '';
}

describe('buildContentSecurityPolicy', () => {
  it('sets a nonce script policy and a report endpoint', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'nonce-value',
      development: false,
      upgradeInsecureRequests: true,
    });

    expect(policy).toContain("default-src 'self'");
    expect(directive(policy, 'script-src')).toBe(
      "script-src 'self' 'nonce-nonce-value' 'strict-dynamic'",
    );
    expect(directive(policy, 'script-src')).not.toContain('unsafe-inline');
    expect(directive(policy, 'script-src')).not.toContain('unsafe-eval');
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain(`style-src 'self' 'nonce-nonce-value'`);
    expect(policy).toContain('upgrade-insecure-requests');
    expect(policy).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(policy).toContain('report-to csp-endpoint');
  });

  it('allows the development runtime to evaluate code and inline styles', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'dev-nonce',
      development: true,
      upgradeInsecureRequests: false,
    });

    expect(directive(policy, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(policy, 'script-src')).toContain("'nonce-dev-nonce'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain('upgrade-insecure-requests');
  });
});

describe('createNonce', () => {
  it('returns a fresh value on each call', () => {
    const first = createNonce();
    const second = createNonce();
    expect(first).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(second).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(first).not.toBe(second);
  });
});
