/* eslint-disable no-restricted-properties -- this CLI decides whether drizzle-kit push may run. */
import { spawnSync } from 'node:child_process';
import { assertLocalDatabasePush } from '@/db/db-push-guard';

try {
  assertLocalDatabasePush(process.env.DATABASE_URL);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const child = spawnSync('pnpm', ['exec', 'drizzle-kit', 'push'], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(child.status ?? 1);
