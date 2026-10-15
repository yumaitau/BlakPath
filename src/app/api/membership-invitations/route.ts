import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  createMembershipInvitation,
  listMembershipInvitations,
} from '@/domains/memberships';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

const createInvitationSchema = z.object({
  email: z.email(),
  roleId: z.uuid(),
  teamId: z.uuid().optional(),
});

export const GET = tenantHandler(async function GET(): Promise<Response> {
  const invitations = await withRequestTenant(() => listMembershipInvitations());
  return NextResponse.json({ invitations });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  await requireRecentAuth(STEP_UP_WINDOWS.privileged);
  const body = createInvitationSchema.parse(await request.json().catch(() => null));
  const result = await withRequestTenant(() =>
    createMembershipInvitation({
      email: body.email,
      roleId: body.roleId,
      ...(body.teamId ? { teamId: body.teamId } : {}),
    }),
  );
  return NextResponse.json(
    {
      invitation: result.invitation,
      url: new URL(result.path, request.nextUrl.origin).toString(),
    },
    { status: 201 },
  );
});
