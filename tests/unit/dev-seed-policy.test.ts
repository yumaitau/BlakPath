import { describe, expect, it } from 'vitest';
import { decideDevSeed, DEV_SEED_REFUSAL } from '@/db/seeds/dev-seed-policy';

const local = 'postgres://blakpath:blakpath@127.0.0.1:5432/blakpath';
const remote = 'postgres://app:secret@db.internal/blakpath?sslmode=verify-full';

describe('developer seed policy', () => {
  it('creates accounts only for an explicit local opt-in', () => {
    expect(
      decideDevSeed({
        nodeEnv: 'development',
        databaseUrl: local,
        allowDevSeed: '1',
      }),
    ).toEqual({ action: 'create' });
    expect(
      decideDevSeed({
        nodeEnv: 'test',
        databaseUrl: 'postgres://blakpath:blakpath@localhost:5432/blakpath_test',
        allowDevSeed: '1',
      }),
    ).toEqual({ action: 'create' });
    expect(
      decideDevSeed({
        nodeEnv: 'development',
        databaseUrl: 'postgres://blakpath:blakpath@[::1]:5432/blakpath',
        allowDevSeed: '1',
      }),
    ).toEqual({ action: 'create' });
  });

  it('skips developer accounts in production even when the flag and host would allow them', () => {
    expect(
      decideDevSeed({
        nodeEnv: 'production',
        databaseUrl: local,
        allowDevSeed: '1',
      }).action,
    ).toBe('skip');
    expect(
      decideDevSeed({
        nodeEnv: 'production',
        databaseUrl: remote,
        allowDevSeed: undefined,
      }).action,
    ).toBe('skip');
  });

  it('skips a local database that has not opted in', () => {
    expect(
      decideDevSeed({
        nodeEnv: 'development',
        databaseUrl: local,
        allowDevSeed: undefined,
      }).action,
    ).toBe('skip');
  });

  it('refuses a non-local host without the flag', () => {
    expect(
      decideDevSeed({
        nodeEnv: 'development',
        databaseUrl: remote,
        allowDevSeed: undefined,
      }),
    ).toEqual({ action: 'refuse', reason: DEV_SEED_REFUSAL });
  });

  it('refuses a non-local host even when the flag is set', () => {
    expect(
      decideDevSeed({
        nodeEnv: 'development',
        databaseUrl: remote,
        allowDevSeed: '1',
      }).action,
    ).toBe('refuse');
  });
});
