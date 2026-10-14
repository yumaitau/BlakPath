import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireRecentAuth } from '@/lib/auth/session';
import { STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { createApiKey, listApiKeys } from '@/domains/api-keys';

/**
 * API-key management (staff, session-authenticated).
 * - GET  — list the tenant's keys (never the secret).
 * - POST — create a key; the raw secret is returned ONCE.
 */
export async function GET(): Promise<Response> {
  try {
    const items = await withRequestTenant(() => listApiKeys());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_ROUTES['POST /api/keys']);
    const body: unknown = await request.json();
    const result = await withRequestTenant(() =>
      createApiKey(body as { name: string; scopes: string[]; expiresInDays?: number }),
    );
    // The raw key is shown exactly once — the caller must store it now.
    return NextResponse.json({
      id: result.apiKey.id,
      name: result.apiKey.name,
      prefix: result.apiKey.prefix,
      key: result.key,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
