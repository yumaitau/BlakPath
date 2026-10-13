import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const canary = require('../../infra/aws/synthetics/ready-signin.cjs') as {
  evaluateReady: (status: number, body: string) => string | null;
  evaluateSignIn: (status: number, body: string) => string | null;
};

describe('ready and sign-in canary', () => {
  it('accepts a ready body and a rendered sign-in page', () => {
    expect(canary.evaluateReady(200, '{ "status": "ready", "checks": {} }')).toBeNull();
    expect(canary.evaluateSignIn(200, '<h1>Sign in</h1>')).toBeNull();
  });

  it('fails closed on dependency outage and a missing sign-in marker', () => {
    expect(canary.evaluateReady(503, '{"status":"not_ready"}')).toMatch(/503/);
    expect(canary.evaluateReady(200, '{"status":"not_ready"}')).toBe('ready body');
    expect(canary.evaluateSignIn(500, 'Sign in')).toMatch(/500/);
    expect(canary.evaluateSignIn(200, '<html></html>')).toBe('sign-in marker');
  });
});
