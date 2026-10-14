import type { Logger } from 'pino';
import { sweepOrganisationKeyHealth } from '@/domains/organisation-keys/health';
import { KEY_HEALTH_INTERVAL_MS } from '@/lib/encryption/key-health';
import { promotePausedTenantJobs } from './resume-tenant-jobs';

/**
 * Probe tenant keys inside the DEK cache TTL. A restored key promotes the
 * jobs this process delayed. A probe failure is logged and retried next tick.
 */
export function startKeyHealthLoop(logger: Logger): () => void {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void sweepOrganisationKeyHealth({
      resume: (organisationId) =>
        promotePausedTenantJobs(organisationId).then(() => undefined),
    })
      .then((results) => {
        const changed = results.filter((result) => result.action !== 'none');
        if (changed.length > 0) logger.info({ changed }, 'tenant key health');
      })
      .catch((err: unknown) => logger.error({ err }, 'tenant key health failed'))
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, KEY_HEALTH_INTERVAL_MS);
  timer.unref();
  tick();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
