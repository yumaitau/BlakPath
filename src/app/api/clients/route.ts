import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { createClient, listClients, type CreateClientInput } from '@/domains/teams';

/** GET /api/clients — list tenant clients. POST — register client. */
export async function GET(): Promise<Response> {
  try {
    const rows = await withRequestTenant(() => listClients());
    return NextResponse.json({ clients: rows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = (await request.json()) as CreateClientInput;
    const row = await withRequestTenant(() => createClient(body));
    return NextResponse.json({ client: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
