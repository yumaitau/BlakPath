import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { createScimCredential, listScimCredentials } from '@/domains/scim';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * SCIM credential management (staff, session-authenticated).
 * - GET  — list the tenant's credentials (never the secret).
 * - POST — create a credential; needs a recent sign-in. The raw token is
 *   returned ONCE.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const items = await withRequestTenant(() => listScimCredentials());
  return NextResponse.json({ items });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/scim/credentials']);
  const body: unknown = await request.json();
  const result = await withRequestTenant(() =>
    createScimCredential(body as Parameters<typeof createScimCredential>[0]),
  );
  return NextResponse.json({
    id: result.credential.id,
    name: result.credential.name,
    prefix: result.credential.prefix,
    allowOrganisationAdmin: result.credential.allowOrganisationAdmin,
    token: result.token,
  });
});
