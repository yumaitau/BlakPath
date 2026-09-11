import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import {
  activateRepresentativeAccess,
  revokeRepresentativeAccess,
} from '@/domains/representatives';

/**
 * PATCH /api/representatives/[id] — { operation: 'activate' | 'revoke' }.
 * Activation re-checks live consent; lapsed consent denies.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json()) as { operation: string };
    if (body.operation === 'activate') {
      const row = await withRequestTenant(() => activateRepresentativeAccess(id));
      return NextResponse.json({ authorisation: row });
    }
    if (body.operation === 'revoke') {
      const row = await withRequestTenant(() => revokeRepresentativeAccess(id));
      return NextResponse.json({ authorisation: row });
    }
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
