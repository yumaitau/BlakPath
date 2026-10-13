import { NextResponse } from 'next/server';
import { removeTeamMember } from '@/domains/teams';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** DELETE /api/teams/:id/members/:userId — remove a team member. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
): Promise<Response> {
  try {
    const { id, userId } = await params;
    await withRequestTenant(() => removeTeamMember({ teamId: id, userId }));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
