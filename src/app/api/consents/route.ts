import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { listConsents, recordConsent, type RecordConsentInput } from '@/domains/consent';

/**
 * GET /api/consents?subject=<userId>&client=<clientId> — a person's consent
 * history (staff). POST — record a grant against a wording version.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const subject = params.get('subject') ?? undefined;
    const client = params.get('client') ?? undefined;
    if (!subject && !client) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const rows = await withRequestTenant(() =>
      listConsents({ subjectUserId: subject, subjectClientId: client }),
    );
    return NextResponse.json({ consents: rows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = (await request.json()) as RecordConsentInput;
    const row = await withRequestTenant(() => recordConsent(body));
    return NextResponse.json({ consent: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
