import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { listConsents, recordConsent } from '@/domains/consent';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';

/** GET /api/consents?subject= — list. POST — record grant. */
export const GET = tenantHandler(async function GET(
  request: NextRequest,
): Promise<Response> {
  const subject = new URL(request.url).searchParams.get('subject');
  if (!subject) throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Invalid request');
  const rows = await withRequestTenant(() => listConsents(subject));
  return NextResponse.json({ consents: rows });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as {
    subjectUserId: string;
    purpose: string;
    expiresAt?: string;
    notes?: string;
  };
  const row = await withRequestTenant(() =>
    recordConsent({
      ...body,
      ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {}),
    }),
  );
  return NextResponse.json({ consent: row }, { status: 201 });
});
