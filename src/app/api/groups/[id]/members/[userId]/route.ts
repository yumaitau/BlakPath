import { NextResponse } from 'next/server';
import { removeGroupMember } from '@/domains/teams';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** DELETE /api/groups/:id/members/:userId — remove a group member. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
): Promise<Response> {
  try {
    const { id, userId } = await params;
    await withRequestTenant(() => removeGroupMember({ groupId: id, userId }));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
