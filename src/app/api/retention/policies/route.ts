import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { createPolicy, listPolicies, type CreatePolicyInput } from '@/domains/retention';

/**
 * Retention policies.
 * GET list / POST draft ({ resourceType, retentionDays, action, jurisdiction, authorityReference? }).
 * A draft stays inactive until a different person activates it.
 */
export async function GET(): Promise<Response> {
  try {
    const items = await withRequestTenant(() => listPolicies());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body: unknown = await request.json();
    const row = await withRequestTenant(() => createPolicy(body as CreatePolicyInput));
    return NextResponse.json({ id: row.id });
  } catch (error) {
    return toErrorResponse(error);
  }
}
