import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import {
  createInvitation,
  listInvitations,
  type CreateInvitationInput,
} from '@/domains/forms';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET  /api/forms/[id]/invitations — list a form's invitations.
 * POST /api/forms/[id]/invitations — mint a new invitation.
 *
 * The raw token is returned by the service exactly once. We build the absolute
 * shareable link from the request origin and hand it back so staff can copy it;
 * the token itself is never stored in the clear.
 */
export const GET = tenantHandler(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const invitations = await withRequestTenant(() => listInvitations(id));
  return NextResponse.json({ invitations });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json()) as CreateInvitationInput;
  const result = await withRequestTenant(() => createInvitation(id, body));

  // Build an absolute link from the request origin so staff can copy it.
  const origin = request.nextUrl.origin;
  const url = new URL(result.path, origin).toString();

  return NextResponse.json(
    {
      invitation: result.invitation,
      path: result.path,
      url,
    },
    { status: 201 },
  );
});
