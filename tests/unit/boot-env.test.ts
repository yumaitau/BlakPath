import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetEnvCache, env } from '@/lib/env';

const TOKEN = 'production-must-reject-this-bootstrap-token';

describe('boot environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetEnvCache();
  });

  it('fails closed when PILOT_BOOTSTRAP_TOKEN is set in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PILOT_BOOTSTRAP_TOKEN', TOKEN);
    __resetEnvCache();
    expect(() => env.NODE_ENV).toThrow(/PILOT_BOOTSTRAP_TOKEN/);
  });

  it('still loads outside production when the retired variable is present', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PILOT_BOOTSTRAP_TOKEN', TOKEN);
    __resetEnvCache();
    expect(env.PILOT_BOOTSTRAP_TOKEN).toBe(TOKEN);
  });
});
