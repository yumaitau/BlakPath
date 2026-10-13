import { NextResponse } from 'next/server';
import { readinessReport } from '@/lib/health/checks';
import { env } from '@/lib/env';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * Aggregate health endpoint.
 *
 * Combines liveness (the process answered) with the readiness dependency
 * report into a single overview for dashboards and uptime monitors. Emits only
 * non-sensitive metadata (service name, region, coarse dependency statuses) —
 * never versions of secrets, connection strings, or applicant data.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = tenantHandler(async function GET(): Promise<NextResponse> {
  const report = await readinessReport();
  const healthy = report.ready;

  return NextResponse.json(
    {
      status: healthy ? 'healthy' : 'degraded',
      service: env.OTEL_SERVICE_NAME,
      region: env.APP_REGION,
      time: new Date().toISOString(),
      checks: report.checks,
    },
    {
      status: healthy ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
});
