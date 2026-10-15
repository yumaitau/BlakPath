import { NextResponse } from 'next/server';
import { verifyOrganisationDomain } from '@/domains/organisation-settings';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * POST /api/organisation-domains/[id]/verify — check the DNS TXT record. A
 * verified domain can carry SSO, so this requires step-up.
 */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['POST /api/organisation-domains/[id]/verify']);
  const { id } = await params;
  const domain = await withRequestTenant(() => verifyOrganisationDomain(id));
  return NextResponse.json({ domain });
});
