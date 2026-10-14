import { describe, expect, it } from 'vitest';
import {
  evaluateCookieMutation,
  isMutationOriginExempt,
  MUTATION_ORIGIN_EXEMPT_PREFIXES,
} from '@/lib/http/mutation-guard';

const APP_ORIGIN = 'http://localhost:3000';

function decide(overrides: Partial<Parameters<typeof evaluateCookieMutation>[0]> = {}) {
  return evaluateCookieMutation({
    pathname: '/api/keys',
    method: 'POST',
    origin: APP_ORIGIN,
    contentType: 'application/json',
    appOrigin: APP_ORIGIN,
    ...overrides,
  });
}

describe('mutation origin exempt prefixes', () => {
  it('lists bearer, provider, token and report paths exactly', () => {
    expect([...MUTATION_ORIGIN_EXEMPT_PREFIXES]).toEqual([
      '/api/auth',
      '/api/mcp',
      '/api/v1',
      '/api/scim',
      '/api/email/events',
      '/api/admin/pilot-bootstrap',
      '/api/public',
      '/api/csp-report',
    ]);
  });

  it('matches a prefix only on a path boundary', () => {
    expect(isMutationOriginExempt('/api/auth')).toBe(true);
    expect(isMutationOriginExempt('/api/auth/sign-in/email')).toBe(true);
    expect(isMutationOriginExempt('/api/v1')).toBe(true);
    expect(isMutationOriginExempt('/api/v1/applications')).toBe(true);
    expect(isMutationOriginExempt('/api/public/forms/token')).toBe(true);
    expect(isMutationOriginExempt('/api/email/events')).toBe(true);
    expect(isMutationOriginExempt('/api/csp-report')).toBe(true);

    expect(isMutationOriginExempt('/api/authors')).toBe(false);
    expect(isMutationOriginExempt('/api/v10')).toBe(false);
    expect(isMutationOriginExempt('/api/publications')).toBe(false);
    expect(isMutationOriginExempt('/api/email/send')).toBe(false);
    expect(isMutationOriginExempt('/api/keys')).toBe(false);
    expect(isMutationOriginExempt('/api/webhooks')).toBe(false);
  });

  it('skips the origin and content-type checks on exempt mutations', () => {
    for (const prefix of MUTATION_ORIGIN_EXEMPT_PREFIXES) {
      expect(
        decide({
          pathname: `${prefix}/child`,
          origin: 'https://sibling.example',
          contentType: 'text/plain',
        }),
      ).toEqual({ allow: true });
    }
  });
});

describe('evaluateCookieMutation', () => {
  it('allows safe methods and non-API paths', () => {
    expect(decide({ method: 'GET', origin: null, contentType: null })).toEqual({
      allow: true,
    });
    expect(decide({ method: 'HEAD', origin: 'https://other.example' })).toEqual({
      allow: true,
    });
    expect(
      decide({ pathname: '/dashboard', origin: null, contentType: 'text/plain' }),
    ).toEqual({ allow: true });
  });

  it('allows same-origin JSON, including a charset parameter', () => {
    expect(decide()).toEqual({ allow: true });
    expect(decide({ contentType: 'application/json; charset=utf-8' })).toEqual({
      allow: true,
    });
    expect(decide({ method: 'DELETE', contentType: 'Application/JSON' })).toEqual({
      allow: true,
    });
  });

  it('rejects a cross-origin or missing origin before looking at the body', () => {
    expect(decide({ origin: 'https://sibling.yumait.au' })).toEqual({
      allow: false,
      reason: 'origin',
    });
    expect(decide({ origin: null })).toEqual({ allow: false, reason: 'origin' });
    expect(decide({ origin: 'null' })).toEqual({ allow: false, reason: 'origin' });
    expect(decide({ origin: 'http://localhost:3001' })).toEqual({
      allow: false,
      reason: 'origin',
    });
    expect(decide({ origin: 'not a url' })).toEqual({ allow: false, reason: 'origin' });
  });

  it('rejects text/plain and any non-JSON media type from the application origin', () => {
    expect(decide({ contentType: 'text/plain' })).toEqual({
      allow: false,
      reason: 'content-type',
    });
    expect(decide({ contentType: 'text/calendar' })).toEqual({
      allow: false,
      reason: 'content-type',
    });
    expect(decide({ contentType: 'application/x-www-form-urlencoded' })).toEqual({
      allow: false,
      reason: 'content-type',
    });
    expect(decide({ contentType: null })).toEqual({
      allow: false,
      reason: 'content-type',
    });
  });
});
