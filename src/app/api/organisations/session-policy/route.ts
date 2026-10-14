import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getOrganisationSessionPolicy,
  setOrganisationSessionPolicy,
} from '@/lib/auth/staff-session';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Staff idle timeout for the active organisation.
 *
 * GET returns the resolved timeout in seconds (30–60 minutes; default 45).
 * PATCH sets it from `idleTimeoutMinutes` and requires a fresh authentication.
 * The value only ends idle staff sessions. It does not decide identity.
 */

const patchSchema = z.object({
  idleTimeoutMinutes: z.number().int().min(30).max(60),
});

export async function GET(): Promise<Response> {
  try {
    const policy = await withRequestTenant((ctx) => getOrganisationSessionPolicy(ctx));
    return NextResponse.json(policy);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.privileged);
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const policy = await withRequestTenant((ctx) =>
      setOrganisationSessionPolicy(ctx, parsed.data.idleTimeoutMinutes * 60),
    );
    return NextResponse.json(policy);
  } catch (error) {
    return toErrorResponse(error);
  }
}
