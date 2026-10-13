import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { createSsoBinding, listSsoBindings } from '@/domains/sso';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/sso/providers — list tenant bindings. POST — create binding. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const rows = await withRequestTenant(() => listSsoBindings());
  return NextResponse.json({ providers: rows });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as {
    providerKey: string;
    issuer: string;
    clientId: string;
    domain: string;
  };
  const row = await withRequestTenant(() => createSsoBinding(body));
  return NextResponse.json({ provider: row }, { status: 201 });
});
