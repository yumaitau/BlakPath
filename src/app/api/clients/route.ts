import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { createClient, listClients, type CreateClientInput } from '@/domains/teams';
import { tenantHandler } from '@/lib/http/error-response';

/** GET /api/clients — list tenant clients. POST — register client. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const rows = await withRequestTenant(() => listClients());
  return NextResponse.json({ clients: rows });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as CreateClientInput;
  const row = await withRequestTenant(() => createClient(body));
  return NextResponse.json({ client: row }, { status: 201 });
});
