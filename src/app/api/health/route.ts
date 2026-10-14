import { NextResponse } from 'next/server';
import { detailedHealthForbidden } from '@/lib/health/access';
import { readinessReport } from '@/lib/health/checks';
import { env } from '@/lib/env';

/**
 * Detailed operator health report.
 *
 * Not a probe. Kubernetes liveness uses `/api/live`; readiness and the ALB
 * target health check use `/api/ready`. This response adds service name and
 * region to the cached dependency report. It is refused when the request
 * arrived through the public edge (see `detailedHealthForbidden`). In-VPC
 * callers that reach the pod directly still get the report.
 *
 * Emits only non-sensitive metadata — never secrets, connection strings, or
 * applicant data. Refused requests do not touch dependencies.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  if (detailedHealthForbidden(request.headers)) {
    return NextResponse.json(
      { error: 'Forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

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
}
