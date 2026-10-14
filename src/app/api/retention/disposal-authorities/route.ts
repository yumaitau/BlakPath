import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  listDisposalAuthorities,
  signDisposalAuthority,
  type SignDisposalAuthorityInput,
} from '@/domains/retention';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Disposal-authority sign-offs for this organisation.
 * GET lists current (not superseded) sign-offs.
 * POST records a records manager's sign-off for one class in one jurisdiction.
 * POST requires step-up.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const items = await withRequestTenant(() => listDisposalAuthorities());
  return NextResponse.json({ items });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/retention/disposal-authorities']);
  const body: unknown = await request.json();
  const row = await withRequestTenant(() =>
    signDisposalAuthority(body as SignDisposalAuthorityInput),
  );
  return NextResponse.json({ id: row.id });
});
