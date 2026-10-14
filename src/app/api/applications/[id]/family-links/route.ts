import { NextResponse } from 'next/server';
import {
  listFamilyLinks,
  requestFamilyLink,
  type RequestFamilyLinkInput,
} from '@/domains/family-links';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * GET  /api/applications/[id]/family-links — list links. Needs a family-link
 *      permission and a staff read of the case; applicants are refused.
 * POST /api/applications/[id]/family-links — record a link (`family-link:request`).
 *
 * Recording a link is a human act. It does not approve the link or determine
 * Aboriginality. Approval is a different route and must be a different person.
 */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const links = await withRequestTenant(() => listFamilyLinks(id));
  return NextResponse.json({ links });
});

export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = (await request.json()) as RequestFamilyLinkInput;
  const link = await withRequestTenant(() => requestFamilyLink(id, input));
  return NextResponse.json({ link }, { status: 201 });
});
