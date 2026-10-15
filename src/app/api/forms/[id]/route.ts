import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import {
  getForm,
  listInvitations,
  listResponses,
  updateForm,
  type UpdateFormInput,
} from '@/domains/forms';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET   /api/forms/[id] — the form plus its invitations and responses.
 * PATCH /api/forms/[id] — edit the form (title/description/fields).
 *
 * Both run inside a DB-verified tenant context; the service enforces permission.
 */
export const GET = tenantHandler(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const data = await withRequestTenant(async () => ({
    form: await getForm(id),
    invitations: await listInvitations(id),
    responses: await listResponses(id),
  }));
  return NextResponse.json(data);
});

export const PATCH = tenantHandler(async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json()) as UpdateFormInput;
  const form = await withRequestTenant(() => updateForm(id, body));
  return NextResponse.json({ form });
});
