import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { recordMonthlyAuditReview } from '@/domains/audit';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/audit/reviews — record that a person completed the monthly checklist.
 * JSON only: `src/proxy.ts` refuses cookie-authenticated non-JSON mutations.
 */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const input: unknown = await request.json();
  const recorded = await withRequestTenant(() => recordMonthlyAuditReview(input));
  return NextResponse.json(recorded);
});
