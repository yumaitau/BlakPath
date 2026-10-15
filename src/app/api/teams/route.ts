import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { createTeam, listTeams, type CreateTeamInput } from '@/domains/teams';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/teams — list tenant teams. POST — create team. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const rows = await withRequestTenant(() => listTeams());
  return NextResponse.json({ teams: rows });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as CreateTeamInput;
  const row = await withRequestTenant(() => createTeam(body));
  return NextResponse.json({ team: row }, { status: 201 });
});
