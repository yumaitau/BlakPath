import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getCurrentOrganisationKey,
  submitOrganisationKey,
} from '@/domains/organisation-keys/onboarding';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

const bodySchema = z.object({
  kmsKeyArn: z.string().trim().min(20).max(256),
  custodyMode: z.enum(['blakpath_managed', 'client_owned', 'client_owned_escrow']),
});

export async function GET(): Promise<Response> {
  try {
    const key = await withRequestTenant(() => getCurrentOrganisationKey());
    return NextResponse.json({ key });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.privileged);
    const body = bodySchema.parse(await request.json().catch(() => null));
    const key = await withRequestTenant(() => submitOrganisationKey(body));
    return NextResponse.json({ key });
  } catch (error) {
    return toErrorResponse(error);
  }
}
