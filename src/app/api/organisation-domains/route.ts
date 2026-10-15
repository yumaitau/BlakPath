import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  addOrganisationDomain,
  listOrganisationDomains,
} from '@/domains/organisation-settings';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** GET /api/organisation-domains — claimed domains. POST — claim a domain (step-up). */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const domains = await withRequestTenant(() => listOrganisationDomains());
  return NextResponse.json({ domains });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/organisation-domains']);
  const body: unknown = await request.json();
  const domain = await withRequestTenant(() => addOrganisationDomain(body));
  return NextResponse.json({ domain }, { status: 201 });
});
