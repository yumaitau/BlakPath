import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { provisionScimUser, setScimUserActive, verifyScimBearer } from '@/domains/scim';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';

/** POST /api/scim/v2/[orgId]/Users — provision user + membership. */
export const POST = tenantHandler(
  async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ orgId: string }> },
  ): Promise<Response> {
    verifyScimBearer(request);
    const { orgId } = await params;
    const result = await provisionScimUser(orgId, await request.json());
    return NextResponse.json(
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        id: result.id,
        userName: result.userName,
        active: true,
      },
      { status: 201 },
    );
  },
  { presentation: 'scim' },
);

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
 * DELETE with ?userName= — suspend membership (history preserved, never erased).
 */
export const PATCH = tenantHandler(
  async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ orgId: string }> },
  ): Promise<Response> {
    verifyScimBearer(request);
    const { orgId } = await params;
    const body = patchSchema.parse(await request.json());
    const userName = body.userName;
    const op = (body.Operations ?? []).find((o) => o.op.toLowerCase() === 'replace');
    const active =
      body.active ??
      (typeof op?.value === 'object' && op?.value !== null
        ? (op.value as Record<string, unknown>).active
        : undefined);
    if (!userName || typeof active !== 'boolean') {
      throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Invalid request');
    }
    await setScimUserActive(orgId, userName, active);
    return NextResponse.json({ userName, active });
  },
  { presentation: 'scim' },
);

export const DELETE = tenantHandler(
  async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ orgId: string }> },
  ): Promise<Response> {
    verifyScimBearer(request);
    const { orgId } = await params;
    const userName = new URL(request.url).searchParams.get('userName');
    if (!userName) throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Invalid request');
    await setScimUserActive(orgId, userName, false);
    return new NextResponse(null, { status: 204 });
  },
  { presentation: 'scim' },
);
