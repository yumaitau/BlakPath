import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { getOrganisationStats } from '@/domains/dashboard';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET /api/dashboard/stats — the organisation's work-pipeline stats and the
 * derived "needs attention" list. Permission-checked (`report:view` OR
 * `application:read-any`) and tenant-scoped via `withRequestTenant`. Read-only.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const data = await withRequestTenant(() => getOrganisationStats());
  return NextResponse.json(data);
});
