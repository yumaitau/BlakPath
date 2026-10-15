import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { createGroup, listGroups, type CreateGroupInput } from '@/domains/teams';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/groups — list tenant groups. POST — create group. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const rows = await withRequestTenant(() => listGroups());
  return NextResponse.json({ groups: rows });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as CreateGroupInput;
  const row = await withRequestTenant(() => createGroup(body));
  return NextResponse.json({ group: row }, { status: 201 });
});
