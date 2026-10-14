import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { createPolicy, listPolicies, type CreatePolicyInput } from '@/domains/retention';
import { tenantHandler } from '@/lib/http/error-response';

/** Retention policies. GET list / POST create ({ resourceType, retentionDays, action }). */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const items = await withRequestTenant(() => listPolicies());
  return NextResponse.json({ items });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body: unknown = await request.json();
  const row = await withRequestTenant(() => createPolicy(body as CreatePolicyInput));
  return NextResponse.json({ id: row.id });
});
