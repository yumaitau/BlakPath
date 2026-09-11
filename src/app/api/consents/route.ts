import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { listConsents, recordConsent } from '@/domains/consent';

/** GET /api/consents?subject= — list. POST — record grant. */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const subject = new URL(request.url).searchParams.get('subject');
    if (!subject) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const rows = await withRequestTenant(() => listConsents(subject));
    return NextResponse.json({ consents: rows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
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
  } catch (error) {
    return toErrorResponse(error);
  }
}
