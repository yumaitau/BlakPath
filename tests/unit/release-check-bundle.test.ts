import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { PRODUCTION_ENV } from '../helpers/production-env';

const authSecret = PRODUCTION_ENV.BETTER_AUTH_SECRET!;

const valid: NodeJS.ProcessEnv = {
  ...PRODUCTION_ENV,
  NODE_ENV: 'production',
  DATABASE_MIGRATION_URL:
    'postgres://blakpath_migrator:secret@db.internal/blakpath?sslmode=verify-full',
  PATH: process.env.PATH ?? '',
};

function runCheck(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['dist/release-check/release-check.cjs'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
}

describe('release-check bundle', () => {
  beforeAll(() => {
    const built = spawnSync(process.execPath, ['scripts/build-release-check.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(built.status, built.stderr).toBe(0);
  });

  it('exits 0 for a production configuration', () => {
    const result = runCheck(valid);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain(authSecret);
  });

  it('exits 1 when COA_SIGNING_KEY_ID is missing and does not print secrets', () => {
    const { COA_SIGNING_KEY_ID: _dropped, ...missing } = valid;
    const result = runCheck(missing);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('COA_SIGNING_KEY_ID');
    expect(result.stderr).not.toContain(authSecret);
    expect(result.stdout).not.toContain(authSecret);
  });
});
