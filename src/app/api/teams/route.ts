import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { createTeam, listTeams, type CreateTeamInput } from '@/domains/teams';

/** GET /api/teams — list tenant teams. POST — create team. */
export async function GET(): Promise<Response> {
  try {
    const rows = await withRequestTenant(() => listTeams());
    return NextResponse.json({ teams: rows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = (await request.json()) as CreateTeamInput;
    const row = await withRequestTenant(() => createTeam(body));
    return NextResponse.json({ team: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
