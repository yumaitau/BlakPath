import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { createForm, listForms, type CreateFormInput } from '@/domains/forms';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET  /api/forms — list the tenant's forms.
 * POST /api/forms — create a form (JSON body). Both run inside a DB-verified
 * tenant context; the service layer enforces permission and audits the write.
 *
 * PRODUCT INVARIANT: a form only collects information a human provides. It never
 * determines a person's Aboriginality.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const forms = await withRequestTenant(() => listForms());
  return NextResponse.json({ forms });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as CreateFormInput;
  const form = await withRequestTenant(() => createForm(body));
  return NextResponse.json({ form }, { status: 201 });
});
