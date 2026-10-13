import { NextResponse } from 'next/server';
import { readinessReport } from '@/lib/health/checks';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * Readiness probe.
 *
 * Reports whether the service can serve traffic by checking core dependencies
 * (database, Redis, object storage) and surfacing ClamAV status for visibility.
 * Returns 503 when not ready so a load balancer removes the instance from
 * rotation. The response contains only coarse statuses — never hosts, secrets,
 * or connection details.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = tenantHandler(async function GET(): Promise<NextResponse> {
  const report = await readinessReport();
  return NextResponse.json(
    { status: report.ready ? 'ready' : 'not_ready', checks: report.checks },
    {
      status: report.ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
});
