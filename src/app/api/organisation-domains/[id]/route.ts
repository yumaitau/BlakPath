import { NextResponse } from 'next/server';
import { removeOrganisationDomain } from '@/domains/organisation-settings';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * DELETE /api/organisation-domains/[id] — drop a claimed domain. It also turns
 * off SSO bindings on that domain, so it requires step-up.
 */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_ROUTES['DELETE /api/organisation-domains/[id]']);
  const { id } = await params;
  await withRequestTenant(() => removeOrganisationDomain(id));
  return NextResponse.json({ ok: true });
});
