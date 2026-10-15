import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getOrganisationSettings,
  updateOrganisationSetting,
} from '@/domains/organisation-settings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** GET /api/organisation-settings — current tenant settings. PATCH — replace one field. */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const settings = await withRequestTenant(() => getOrganisationSettings());
  return NextResponse.json({ settings });
});

export const PATCH = tenantHandler(async function PATCH(
  request: NextRequest,
): Promise<Response> {
  const body: unknown = await request.json();
  const settings = await withRequestTenant(() => updateOrganisationSetting(body));
  return NextResponse.json({ settings });
});
