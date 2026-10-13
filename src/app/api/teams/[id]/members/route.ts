import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { addTeamMember, listTeamMembers } from '@/domains/teams';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** GET /api/teams/:id/members — members of one team. POST — add a member. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const members = await withRequestTenant(() => listTeamMembers());
    return NextResponse.json({
      members: members.filter((member) => member.teamId === id),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      userId?: string;
      role?: 'lead' | 'member';
    } | null;
    const member = await withRequestTenant(() =>
      addTeamMember({
        teamId: id,
        userId: body?.userId ?? '',
        role: body?.role,
      }),
    );
    return NextResponse.json({ member }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
