import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { createGroup, listGroups, type CreateGroupInput } from '@/domains/teams';

/** GET /api/groups — list tenant groups. POST — create group. */
export async function GET(): Promise<Response> {
  try {
    const rows = await withRequestTenant(() => listGroups());
    return NextResponse.json({ groups: rows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = (await request.json()) as CreateGroupInput;
    const row = await withRequestTenant(() => createGroup(body));
    return NextResponse.json({ group: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
