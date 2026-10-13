import { NextResponse } from 'next/server';
import {
  listFamilyLinks,
  requestFamilyLink,
  type RequestFamilyLinkInput,
} from '@/domains/family-links';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * GET  /api/applications/[id]/family-links — list links the actor may read.
 * POST /api/applications/[id]/family-links — record a link (`family-link:request`).
 *
 * Recording a link is a human act. It does not approve the link or determine
 * Aboriginality. Approval is a different route and must be a different person.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const links = await withRequestTenant(() => listFamilyLinks(id));
    return NextResponse.json({ links });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const input = (await request.json()) as RequestFamilyLinkInput;
    const link = await withRequestTenant(() => requestFamilyLink(id, input));
    return NextResponse.json({ link }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
