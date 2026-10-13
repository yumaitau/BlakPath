import { NextResponse } from 'next/server';
import { removeOrganisationDomain } from '@/domains/organisation-settings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** DELETE /api/organisation-domains/[id] — drop a claimed domain. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    await withRequestTenant(() => removeOrganisationDomain(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
