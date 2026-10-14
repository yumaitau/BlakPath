import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  authenticateScim,
  provisionScimUser,
  revokeScimUser,
  setScimUserActive,
} from '@/domains/scim';
import { toErrorResponse } from '@/lib/http/tenant-route';
import { clientIp } from '@/lib/http/client-ip';
import { REQUEST_LIMITS, limitIp, limitSubject } from '@/lib/http/request-limits';
import { AuthorizationError } from '@/lib/permissions/errors';

/** IP first, then the presented bearer. A missing bearer still spends the IP budget. */
async function limitScim(request: NextRequest): Promise<Response | null> {
  const ipLimited = await limitIp(REQUEST_LIMITS.scim, clientIp(request.headers));
  if (ipLimited) return ipLimited;
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  const bearer = match?.[1]?.trim() ?? '';
  if (!bearer) return null;
  return limitSubject(REQUEST_LIMITS.scim, bearer);
}

function scimError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return NextResponse.json(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: '403',
        detail: 'Forbidden',
      },
      { status: 403 },
    );
  }
  return toErrorResponse(error);
}

/** POST /api/scim/v2/[orgId]/Users — provision user + membership. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const limited = await limitScim(request);
  if (limited) return limited;
  try {
    const { orgId } = await params;
    const auth = await authenticateScim(request, orgId);
    const result = await provisionScimUser(auth, orgId, await request.json());
    return NextResponse.json(
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        id: result.id,
        userName: result.userName,
        active: result.active,
      },
      { status: 201 },
    );
  } catch (error) {
    return scimError(error);
  }
}

const patchSchema = z.object({
  Operations: z
    .array(
      z.object({
        op: z.string(),
        path: z.string().optional(),
        value: z.unknown().optional(),
      }),
    )
    .optional(),
  active: z.boolean().optional(),
  userName: z.string().optional(),
});

/**
 * PATCH — set active flag (userName in body, or replace op on active).
 * DELETE with ?userName= — revoke the membership (row kept, access ended).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const limited = await limitScim(request);
  if (limited) return limited;
  try {
    const { orgId } = await params;
    const auth = await authenticateScim(request, orgId);
    const body = patchSchema.parse(await request.json());
    const userName = body.userName;
    const op = (body.Operations ?? []).find(
      (item) => item.op.toLowerCase() === 'replace',
    );
    const active =
      body.active ??
      (typeof op?.value === 'object' && op?.value !== null
        ? (op.value as Record<string, unknown>).active
        : undefined);
    if (!userName || typeof active !== 'boolean') {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    await setScimUserActive(auth, orgId, userName, active);
    return NextResponse.json({ userName, active });
  } catch (error) {
    return scimError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const limited = await limitScim(request);
  if (limited) return limited;
  try {
    const { orgId } = await params;
    const auth = await authenticateScim(request, orgId);
    const userName = new URL(request.url).searchParams.get('userName');
    if (!userName) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    await revokeScimUser(auth, orgId, userName);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return scimError(error);
  }
}
