import { NextResponse } from 'next/server';
import { activatePolicy } from '@/domains/retention';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * POST /api/retention/policies/[id]/activate
 * A different `retention:manage` holder from the drafter turns the policy on.
 * The drafter's own call is rejected.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const row = await withRequestTenant(() => activatePolicy(id));
    return NextResponse.json({ id: row.id, active: row.active });
  } catch (error) {
    return toErrorResponse(error);
  }
}
