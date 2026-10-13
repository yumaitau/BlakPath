import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  listDisposalAuthorities,
  signDisposalAuthority,
  type SignDisposalAuthorityInput,
} from '@/domains/retention';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Disposal-authority sign-offs for this organisation.
 * GET lists current (not superseded) sign-offs.
 * POST records a records manager's sign-off for one class in one jurisdiction.
 */
export async function GET(): Promise<Response> {
  try {
    const items = await withRequestTenant(() => listDisposalAuthorities());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body: unknown = await request.json();
    const row = await withRequestTenant(() =>
      signDisposalAuthority(body as SignDisposalAuthorityInput),
    );
    return NextResponse.json({ id: row.id });
  } catch (error) {
    return toErrorResponse(error);
  }
}
