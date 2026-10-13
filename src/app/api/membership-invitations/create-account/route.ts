import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { createInvitedAccount } from '@/domains/memberships';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/membership-invitations/create-account — invite-bound signup.
 *
 * The only self-service account path now that open registration is disabled.
 * Body: { token, name, password }. The pending invitation token proves control
 * of the invited email, so the account is verified at creation. Rate-limited
 * by the shared auth rules; failures stay generic to avoid enumerating
 * invitations.
 */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as {
    token: string;
    name: string;
    password: string;
  };
  const result = await createInvitedAccount(body);
  return NextResponse.json(result, { status: 201 });
});
