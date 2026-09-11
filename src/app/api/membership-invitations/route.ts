import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  createMembershipInvitation,
  listMembershipInvitations,
} from '@/domains/memberships';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

const createInvitationSchema = z.object({
  email: z.email(),
  roleId: z.uuid(),
  teamId: z.uuid().optional(),
});

export async function GET(): Promise<Response> {
  try {
    const invitations = await withRequestTenant(() => listMembershipInvitations());
    return NextResponse.json({ invitations });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
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
  } catch (error) {
    return toErrorResponse(error);
  }
}
