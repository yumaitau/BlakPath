import type { Instrumentation } from 'next';

/**
 * Next.js instrumentation hook.
 *
 * Runs once per server process before the app handles requests. We only start
 * OpenTelemetry on the Node.js runtime — the Edge runtime lacks the Node APIs
 * the SDK needs. Telemetry is best-effort and must never block or crash boot.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Fail boot when the Drizzle auth tables cannot store a field an enabled
  // Better Auth plugin writes. The adapter would otherwise drop the write.
  const { assertAuthSchemaCoverage } = await import('@/lib/auth/schema-coverage');
  assertAuthSchemaCoverage();

  // Fail boot on invalid configuration. Later steps are best-effort and must
  // not swallow this.
  const { env } = await import('@/lib/env');
  void env.NODE_ENV;

  const { start } = await import('@/lib/observability/otel');
  await start();

  // Inject the auth transport. Verification sends now; password reset is
  // queued by that transport. Best-effort: a wiring failure must not crash boot.
  try {
    const [{ setAuthMailer }, { authMailer }] = await Promise.all([
      import('@/lib/auth/emails'),
      import('@/lib/email/mailer'),
    ]);
    setAuthMailer(authMailer);
  } catch (err) {
    const { logger } = await import('@/lib/observability/logger');
    logger.error({ err }, 'failed to install auth mailer transport');
  }

  // Register federated SSO providers from env. Absent env = unavailable
  // (secure default). Best-effort like the mailer above.
  try {
    const { registerEntraFromEnv } = await import('@/lib/auth/sso-entra');
    registerEntraFromEnv();
  } catch (err) {
    const { logger } = await import('@/lib/observability/logger');
    logger.error({ err }, 'failed to register SSO providers');
  }
}

/**
 * Server-error correlation. Next.js shows the browser only an opaque `digest`
 * for a server error, which our error pages display as the support reference.
 * Logging it here with the route lets operators go from that reference to the
 * failure. Only the route PATTERN is logged (e.g. `/form/[token]`), never the
 * concrete path, which can carry invitation tokens or record ids.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const [{ logger }, { correlationFromHeaders }] = await Promise.all([
      import('@/lib/observability/logger'),
      import('@/lib/observability/correlation'),
    ]);
    const digest =
      typeof error === 'object' && error !== null && 'digest' in error
        ? String((error as { digest: unknown }).digest)
        : undefined;
    logger.error(
      {
        err: error,
        digest,
        ...correlationFromHeaders(request.headers),
        method: request.method,
        routePath: context.routePath,
        routeType: context.routeType,
        renderSource: context.renderSource,
      },
      'request error',
    );
  } catch {
    // Error reporting must never itself throw.
  }
};
