import { NextResponse } from 'next/server';
import { verifyOrganisationDomain } from '@/domains/organisation-settings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** POST /api/organisation-domains/[id]/verify — check the DNS TXT record. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const domain = await withRequestTenant(() => verifyOrganisationDomain(id));
    return NextResponse.json({ domain });
  } catch (error) {
    return toErrorResponse(error);
  }
}
