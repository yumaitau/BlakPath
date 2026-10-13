import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Refresh or remove the liveness file.
 *
 * The file is rewritten only when Redis answered a ping. A miss deletes it
 * so the probe fails on the next check instead of waiting out the max age.
 * Returns whether the file was left in place.
 */
export async function recordHeartbeat(
  path: string,
  redisReachable: boolean,
  now = Date.now(),
): Promise<boolean> {
  if (!redisReachable) {
    await clearHeartbeat(path);
    return false;
  }
  await writeHeartbeat(path, now);
  return true;
}

export async function writeHeartbeat(path: string, now = Date.now()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${now}\n`, { mode: 0o644 });
  await rename(tmp, path);
}

export async function clearHeartbeat(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function heartbeatExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
