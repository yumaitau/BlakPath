import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { recordMonthlyAuditReview } from '@/domains/audit';
import { UnauthenticatedError } from '@/lib/auth/session';
import { AuthorizationError } from '@/lib/permissions/errors';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

function reviewRedirect(request: NextRequest, query: string): NextResponse {
  return NextResponse.redirect(new URL(`/audit/review?${query}`, request.url), 303);
}

/** POST /api/audit/reviews — record that a person completed the monthly checklist. */
export async function POST(request: NextRequest): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  const wantsHtml = contentType.includes('application/x-www-form-urlencoded');
  try {
    const input = wantsHtml
      ? Object.fromEntries((await request.formData()).entries())
      : await request.json();
    const recorded = await withRequestTenant(() => recordMonthlyAuditReview(input));
    if (wantsHtml) return reviewRedirect(request, 'recorded=1');
    return NextResponse.json(recorded);
  } catch (error) {
    if (wantsHtml) {
      if (error instanceof UnauthenticatedError) {
        return NextResponse.redirect(new URL('/sign-in', request.url), 303);
      }
      const code = error instanceof AuthorizationError ? 'forbidden' : 'invalid';
      return reviewRedirect(request, `error=${code}`);
    }
    return toErrorResponse(error);
  }
}
