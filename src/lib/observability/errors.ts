import { logger } from './logger';
import { recordCapturedError } from './metrics';
import { normalizeHttpRoute } from './route-label';
import { scrubErrorForLog, scrubText } from './scrub';

/**
 * In-region error tracking.
 *
 * Exceptions are written as structured operational logs (shipped to CloudWatch
 * in ap-southeast-2) and counted. Messages are scrubbed first. This is not a
 * third-party tracker and it never receives applicant content on purpose.
 */

export interface CaptureContext {
  method?: string;
  /** Route template or raw path. Normalised before it is logged. */
  route?: string;
}

/** Log one exception and count it. Never throws. */
export function captureException(error: unknown, context: CaptureContext = {}): void {
  try {
    const scrubbed = scrubErrorForLog(error);
    const stack =
      error instanceof Error && typeof error.stack === 'string'
        ? scrubText(error.stack)
        : undefined;
    const route = context.route ? normalizeHttpRoute(context.route) : undefined;
    logger.error(
      {
        signal: 'captured_exception',
        errorName: scrubbed.name,
        message: scrubbed.message,
        stack,
        method: context.method,
        route,
      },
      'captured exception',
    );
    recordCapturedError();
  } catch {
    // Error tracking must not replace the original failure.
  }
}
