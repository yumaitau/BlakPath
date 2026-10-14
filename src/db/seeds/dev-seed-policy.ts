/**
 * Decision for whether `pnpm db:seed` may insert local developer accounts.
 *
 * Catalogue and system-role seeding is separate and always allowed. Developer
 * accounts are a local convenience: production never creates them, and every
 * other environment must opt in with ALLOW_DEV_SEED=1 against a loopback
 * database host. A non-local host is refused so the command cannot quietly
 * target a shared database.
 */

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export type DevSeedDecision =
  | { action: 'create' }
  | { action: 'skip'; reason: string }
  | { action: 'refuse'; reason: string };

export const DEV_SEED_REFUSAL =
  'developer accounts require ALLOW_DEV_SEED=1 and a local database host (localhost, 127.0.0.1, or ::1)';

/** Hostname of a postgres URL, or null when the URL cannot be parsed. */
export function databaseHost(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    return new URL(databaseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

export function decideDevSeed(input: {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  allowDevSeed: string | undefined;
}): DevSeedDecision {
  if (input.nodeEnv === 'production') {
    return {
      action: 'skip',
      reason: 'NODE_ENV=production never creates developer accounts',
    };
  }

  const host = databaseHost(input.databaseUrl);
  const local = host !== null && LOCAL_DB_HOSTS.has(host);
  const allowed = input.allowDevSeed === '1';
  if (local && allowed) return { action: 'create' };
  if (!local) return { action: 'refuse', reason: DEV_SEED_REFUSAL };
  return {
    action: 'skip',
    reason: 'ALLOW_DEV_SEED=1 is not set; permission catalogue only',
  };
}
