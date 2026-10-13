import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getOrganisationSettings,
  updateOrganisationSetting,
} from '@/domains/organisation-settings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** GET /api/organisation-settings — current tenant settings. PATCH — replace one field. */
export async function GET(): Promise<Response> {
  try {
    const settings = await withRequestTenant(() => getOrganisationSettings());
    return NextResponse.json({ settings });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  try {
    const settings = await withRequestTenant(() => updateOrganisationSetting(body));
    return NextResponse.json({ settings });
  } catch (error) {
    return toErrorResponse(error);
  }
}
