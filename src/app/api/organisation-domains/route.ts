import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  addOrganisationDomain,
  listOrganisationDomains,
} from '@/domains/organisation-settings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** GET /api/organisation-domains — claimed domains. POST — claim a domain. */
export async function GET(): Promise<Response> {
  try {
    const domains = await withRequestTenant(() => listOrganisationDomains());
    return NextResponse.json({ domains });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  try {
    const domain = await withRequestTenant(() => addOrganisationDomain(body));
    return NextResponse.json({ domain }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
