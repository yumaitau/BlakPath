import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { rotateEndpointSecret } from '@/domains/webhooks';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/webhooks/[id]/rotate — replace the signing secret.
 * The new secret is returned once. Later reads do not include it.
 */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const rotated = await withRequestTenant(() => rotateEndpointSecret(id));
  return NextResponse.json({ id: rotated.id, secret: rotated.secret });
});
