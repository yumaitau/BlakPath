import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetEnvCache, env } from '@/lib/env';
import { clearHeartbeat, recordHeartbeat } from '../../worker/heartbeat';
import { DEFAULT_HEARTBEAT_PATH, HEARTBEAT_MAX_AGE_SECONDS } from '../../worker/runtime';

const script = join(process.cwd(), 'scripts/worker-liveness.sh');

function runProbe(path: string, maxAge = String(HEARTBEAT_MAX_AGE_SECONDS)) {
  return spawnSync('sh', [script], {
    env: {
      ...process.env,
      WORKER_HEARTBEAT_PATH: path,
      WORKER_HEARTBEAT_MAX_AGE_SECONDS: maxAge,
    },
    encoding: 'utf8',
  });
}

describe('worker heartbeat', () => {
  let dir: string | undefined;

  afterEach(async () => {
    __resetEnvCache();
    if (dir) await clearHeartbeat(join(dir, 'heartbeat'));
  });

  it('uses the same default path as the probe and the env schema', () => {
    const previous = process.env.WORKER_HEARTBEAT_PATH;
    delete process.env.WORKER_HEARTBEAT_PATH;
    __resetEnvCache();
    expect(env.WORKER_HEARTBEAT_PATH).toBe(DEFAULT_HEARTBEAT_PATH);
    if (previous === undefined) delete process.env.WORKER_HEARTBEAT_PATH;
    else process.env.WORKER_HEARTBEAT_PATH = previous;
    __resetEnvCache();
    const source = readFileSync(script, 'utf8');
    expect(source).toContain(DEFAULT_HEARTBEAT_PATH);
    expect(source).toContain(String(HEARTBEAT_MAX_AGE_SECONDS));
  });

  it('writes a file the probe accepts only while Redis is reachable', async () => {
    dir = await mkdtemp(join(tmpdir(), 'blakpath-heartbeat-'));
    const path = join(dir, 'heartbeat');

    expect(runProbe(path).status).toBe(1);

    await recordHeartbeat(path, true);
    expect(runProbe(path).status).toBe(0);

    await recordHeartbeat(path, false);
    expect(runProbe(path).status).toBe(1);
  });

  it('fails the probe when the file is older than the max age', async () => {
    dir = await mkdtemp(join(tmpdir(), 'blakpath-heartbeat-'));
    const path = join(dir, 'heartbeat');
    await recordHeartbeat(path, true);
    const stale = new Date(Date.now() - (HEARTBEAT_MAX_AGE_SECONDS + 5) * 1000);
    await utimes(path, stale, stale);
    expect(runProbe(path).status).toBe(1);
  });
});
