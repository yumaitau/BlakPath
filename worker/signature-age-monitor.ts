import type { Logger } from 'pino';
import { clamdTextCommand } from '@/lib/scanning/clamav';
import { parseClamdVersion, signatureAgeSignal } from '@/lib/scanning/signature-age';

/** How often a running worker asks clamd how old its database is. */
export const SIGNATURE_AGE_INTERVAL_MS = 15 * 60 * 1000;

/** Let clamd finish its own startup before the first VERSION query. */
export const SIGNATURE_AGE_INITIAL_DELAY_MS = 60_000;

/**
 * Emit `clamav_signature_age` on an interval.
 * A failed read is not paged here: scanner downtime already raises
 * `clamav_unavailable` from the web readiness check.
 */
export function startSignatureAgeMonitor(logger: Logger): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const raw = await clamdTextCommand('VERSION', { timeoutMs: 5_000 });
      const signal = signatureAgeSignal(parseClamdVersion(raw), new Date());
      if (signal.alert) {
        logger.warn(signal, 'ClamAV signatures are older than 48 hours');
      } else {
        logger.info(signal, 'ClamAV signature age');
      }
    } catch (err) {
      logger.warn(
        { err, signal: 'clamav_signature_age_unknown', alert: false },
        'ClamAV signature age could not be read',
      );
    }
  };

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      void tick().finally(() => {
        if (!stopped) schedule(SIGNATURE_AGE_INTERVAL_MS);
      });
    }, delayMs);
    timer.unref();
  };

  schedule(SIGNATURE_AGE_INITIAL_DELAY_MS);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
