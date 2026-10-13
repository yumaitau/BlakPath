import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import {
  CONSENT_PURPOSES,
  listWordingVersions,
  publishWordingVersion,
  type ConsentPurpose,
  type PublishWordingInput,
} from '@/domains/consent';

/**
 * GET /api/consents/wording?purpose= — published wording versions.
 * POST — publish a new immutable version (`tenant:configure`).
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const purpose = new URL(request.url).searchParams.get('purpose');
    if (purpose && !(CONSENT_PURPOSES as readonly string[]).includes(purpose)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const rows = await withRequestTenant(() =>
      listWordingVersions((purpose as ConsentPurpose | null) ?? undefined),
    );
    return NextResponse.json({ versions: rows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = (await request.json()) as PublishWordingInput;
    const row = await withRequestTenant(() => publishWordingVersion(body));
    return NextResponse.json({ version: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
