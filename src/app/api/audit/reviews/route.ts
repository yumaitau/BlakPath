import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { recordMonthlyAuditReview } from '@/domains/audit';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * POST /api/audit/reviews — record that a person completed the monthly checklist.
 * JSON only: `src/proxy.ts` refuses cookie-authenticated non-JSON mutations.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const input: unknown = await request.json();
    const recorded = await withRequestTenant(() => recordMonthlyAuditReview(input));
    return NextResponse.json(recorded);
  } catch (error) {
    return toErrorResponse(error);
  }
}
