import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { clearSuppression } from '@/domains/email';
import {
  breakGlassErrorResponse,
  requirePlatformOperator,
} from '@/lib/http/platform-route';

/**
 * POST /api/admin/email-suppressions — a platform operator clears an active
 * email suppression. Requires step-up. The address is hashed and not returned.
 * Each cleared row is audited as `email.suppression_cleared`.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const { userId } = await requirePlatformOperator();
    const body: unknown = await request.json();
    const record =
      body !== null && typeof body === 'object'
        ? (body as { address?: unknown; reason?: unknown })
        : {};
    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    const result = await clearSuppression({
      address: typeof record.address === 'string' ? record.address : '',
      actorUserId: userId,
      ...(reason ? { reason } : {}),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    return breakGlassErrorResponse(error);
  }
}
