import { NextResponse } from 'next/server';
import { removeTeamMember } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/** DELETE /api/teams/:id/members/:userId — remove a team member. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
): Promise<Response> {
  const { id, userId } = await params;
  await withRequestTenant(() => removeTeamMember({ teamId: id, userId }));
  return NextResponse.json({ ok: true });
});
