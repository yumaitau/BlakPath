import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createScimCredential, listScimCredentials } from '@/domains/scim';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * SCIM credential management (staff, session-authenticated).
 * - GET  — list the tenant's credentials (never the secret).
 * - POST — create a credential; the raw token is returned ONCE.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const items = await withRequestTenant(() => listScimCredentials());
  return NextResponse.json({ items });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
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
