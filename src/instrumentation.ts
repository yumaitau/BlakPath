/**
 * Next.js instrumentation hook.
 *
 * Runs once per server process before the app handles requests. We only start
 * OpenTelemetry on the Node.js runtime — the Edge runtime lacks the Node APIs
 * the SDK needs. Telemetry is best-effort and must never block or crash boot.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { start } = await import('@/lib/observability/otel');
  await start();

  // Inject the real SMTP transport so better-auth's verification/reset emails
  // actually send. Best-effort: a wiring failure here must not crash boot.
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
