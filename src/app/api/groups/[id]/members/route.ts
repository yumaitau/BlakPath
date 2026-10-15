import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { addGroupMember, listGroupMembers } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/groups/:id/members — members of one group. POST — add a member. */
export const GET = tenantHandler(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const members = await withRequestTenant(() => listGroupMembers());
  return NextResponse.json({
    members: members.filter((member) => member.groupId === id),
  });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { userId?: string } | null;
  const member = await withRequestTenant(() =>
    addGroupMember({ groupId: id, userId: body?.userId ?? '' }),
  );
  return NextResponse.json({ member }, { status: 201 });
});
