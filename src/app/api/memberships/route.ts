import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  addMember,
  listAssignableRoles,
  listManagedMembers,
} from '@/domains/memberships';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { tenantHandler } from '@/lib/http/error-response';

const addMemberSchema = z.object({
  email: z.email(),
  roleId: z.uuid(),
});

export const GET = tenantHandler(async function GET(): Promise<Response> {
  const [members, roles] = await withRequestTenant(async () =>
    Promise.all([listManagedMembers(), listAssignableRoles()]),
  );
  return NextResponse.json({ members, roles });
});
export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  await requireRecentAuth(STEP_UP_WINDOWS.privileged);
  const body = addMemberSchema.parse(await request.json().catch(() => null));
  const member = await withRequestTenant(() => addMember(body));
  return NextResponse.json({ member }, { status: 201 });
});
