import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createScimCredential, listScimCredentials } from '@/domains/scim';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * SCIM credential management (staff, session-authenticated).
 * - GET  — list the tenant's credentials (never the secret).
 * - POST — create a credential; the raw token is returned ONCE.
 */
export async function GET(): Promise<Response> {
  try {
    const items = await withRequestTenant(() => listScimCredentials());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
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
  } catch (error) {
    return toErrorResponse(error);
  }
}
