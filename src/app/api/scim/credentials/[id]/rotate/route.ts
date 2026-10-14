import { NextResponse } from 'next/server';
import { rotateScimCredential } from '@/domains/scim';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * POST /api/scim/credentials/[id]/rotate — revoke the credential and return
 * a replacement token once.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const result = await withRequestTenant(() => rotateScimCredential(id));
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
