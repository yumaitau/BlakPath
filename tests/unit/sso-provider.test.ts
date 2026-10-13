import { afterEach, describe, expect, it } from 'vitest';
import { __resetEnvCache } from '@/lib/env';
import { registerEntraFromEnv } from '@/lib/auth/sso-entra';
import {
  listSsoProviders,
  registerSsoProvider,
  resolveSsoProvider,
  ssoEnabled,
  type SsoProvider,
} from '@/lib/auth/sso-provider';

const stub: SsoProvider = {
  key: 'stub-idp',
  displayName: 'Stub',
  protocol: 'oidc',
  async start() {
    return { redirectUrl: 'https://idp.example/start', state: 'state-1' };
  },
  async complete() {
    return { subject: 'subject-1', emailVerified: true };
  },
};

describe('SSO provider registry', () => {
  afterEach(() => {
    delete process.env.SSO_ENTRA_CLIENT_ID;
    delete process.env.SSO_ENTRA_CLIENT_SECRET;
    delete process.env.SSO_ENTRA_ISSUER;
    __resetEnvCache();
  });

  it('starts empty of the stub and refuses to shadow a registered key', () => {
    expect(resolveSsoProvider('missing')).toBeNull();
    registerSsoProvider(stub);
    expect(ssoEnabled()).toBe(true);
    expect(listSsoProviders()).toContain('stub-idp');
    expect(resolveSsoProvider('stub-idp')?.displayName).toBe('Stub');
    expect(() => registerSsoProvider(stub)).toThrow(/already registered/);
  });

  it('leaves Entra unregistered until both client id and secret are set', () => {
    expect(registerEntraFromEnv()).toBe(false);
    expect(resolveSsoProvider('entra')).toBeNull();

    process.env.SSO_ENTRA_CLIENT_ID = 'entra-client';
    process.env.SSO_ENTRA_CLIENT_SECRET = 'entra-secret';
    process.env.SSO_ENTRA_ISSUER = 'https://login.microsoftonline.com/tenant/v2.0';
    __resetEnvCache();

    expect(registerEntraFromEnv()).toBe(true);
    expect(resolveSsoProvider('entra')?.protocol).toBe('oidc');
    expect(() => registerEntraFromEnv()).toThrow(/already registered/);
  });
});
