import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setSsoBindingEnabled } from '@/domains/sso';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

const enabledSchema = z.object({ enabled: z.boolean() });

/**
 * PATCH /api/sso/providers/[id] — enable or disable a sign-in binding.
 * Enabling is refused unless the email domain is already verified.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const input = enabledSchema.parse(await request.json().catch(() => null));
    const row = await withRequestTenant(() => setSsoBindingEnabled(id, input.enabled));
    return NextResponse.json({
      provider: {
        id: row.id,
        providerKey: row.providerKey,
        domain: row.domain,
        enabled: row.enabled,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
