import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { rotateEndpointSecret } from '@/domains/webhooks';

/**
 * POST /api/webhooks/[id]/rotate — replace the signing secret.
 * The new secret is returned once. Later reads do not include it.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const rotated = await withRequestTenant(() => rotateEndpointSecret(id));
    return NextResponse.json({ id: rotated.id, secret: rotated.secret });
  } catch (error) {
    return toErrorResponse(error);
  }
}
