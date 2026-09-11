import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { createSsoBinding, listSsoBindings } from '@/domains/sso';

/** GET /api/sso/providers — list tenant bindings. POST — create binding. */
export async function GET(): Promise<Response> {
  try {
    const rows = await withRequestTenant(() => listSsoBindings());
    return NextResponse.json({ providers: rows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = (await request.json()) as {
      providerKey: string;
      issuer: string;
      clientId: string;
      domain: string;
    };
    const row = await withRequestTenant(() => createSsoBinding(body));
    return NextResponse.json({ provider: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
