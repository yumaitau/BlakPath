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
    return {
      redirectUrl: 'https://idp.example/start',
      state: 'state-1',
      transaction: 'sealed-transaction',
    };
  },
  async complete() {
    return { subject: 'subject-1', emailVerified: true };
  },
};

describe('SSO provider registry', () => {
  afterEach(() => {
    delete process.env.SSO_ENTRA_CLIENT_ID;
    delete process.env.SSO_ENTRA_CLIENT_SECRET;
    delete process.env.SSO_STATE_SECRET;
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

  it('leaves Entra unregistered until client id, secret and state secret are set', () => {
    expect(registerEntraFromEnv()).toBe(false);
    expect(resolveSsoProvider('entra')).toBeNull();

    process.env.SSO_ENTRA_CLIENT_ID = 'entra-client';
    process.env.SSO_ENTRA_CLIENT_SECRET = 'entra-secret';
    __resetEnvCache();
    // Without a state secret the flow transaction cannot be sealed.
    expect(registerEntraFromEnv()).toBe(false);
    expect(resolveSsoProvider('entra')).toBeNull();

    process.env.SSO_STATE_SECRET = 'sso-state-secret-at-least-32-characters';
    __resetEnvCache();

    expect(registerEntraFromEnv()).toBe(true);
    const registered = resolveSsoProvider('entra');
    expect(registered?.protocol).toBe('oidc');
    // Re-registration is idempotent: the existing provider is kept.
    expect(registerEntraFromEnv()).toBe(true);
    expect(resolveSsoProvider('entra')).toBe(registered);
    expect(listSsoProviders().filter((key) => key === 'entra')).toHaveLength(1);
  });
});
