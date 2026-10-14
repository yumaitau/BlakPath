import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { tenantHandler } from '@/lib/http/error-response';
import { clientIpForLimits } from '@/lib/http/client-ip';
import { REQUEST_LIMITS, limitIp, limitSubject } from '@/lib/http/request-limits';
import { createInvitedAccount } from '@/domains/memberships';

/**
 * POST /api/membership-invitations/create-account — invite-bound signup.
 *
 * The only self-service account path now that open registration is disabled.
 * Body: { token, name, password }. The pending invitation token proves control
 * of the invited email, so the account is verified at creation. Limited per
 * client IP and per invitation token; failures stay generic to avoid
 * enumerating invitations.
 */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const ipLimited = await limitIp(
    REQUEST_LIMITS.createAccount,
    clientIpForLimits(request.headers),
  );
  if (ipLimited) return ipLimited;
  const body: unknown = await request.json();
  const token =
    body &&
    typeof body === 'object' &&
    typeof (body as { token?: unknown }).token === 'string'
      ? (body as { token: string }).token
      : '';
  if (token) {
    const tokenLimited = await limitSubject(REQUEST_LIMITS.createAccount, token);
    if (tokenLimited) return tokenLimited;
  }
  const result = await createInvitedAccount(body);
  return NextResponse.json(result, { status: 201 });
});
