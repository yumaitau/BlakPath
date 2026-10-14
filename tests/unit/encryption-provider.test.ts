import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetEnvCache } from '@/lib/env';

describe('local encryption provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetEnvCache();
  });

  it('refuses ENCRYPTION_LOCAL_KEY in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENCRYPTION_LOCAL_KEY', Buffer.alloc(32, 2).toString('base64'));
    __resetEnvCache();
    vi.resetModules();
    const { createKeyProvider } = await import('@/lib/encryption/provider');
    expect(() => createKeyProvider()).toThrow(/refused in production/);
  });
});
