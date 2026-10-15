import { NextResponse } from 'next/server';
import { removeGroupMember } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/** DELETE /api/groups/:id/members/:userId — remove a group member. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
): Promise<Response> {
  const { id, userId } = await params;
  await withRequestTenant(() => removeGroupMember({ groupId: id, userId }));
  return NextResponse.json({ ok: true });
});
