import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { importMeetingsFromIcs } from '@/domains/meetings';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';

/** Reject absurdly large uploads before parsing (1 MiB is ample for meetings). */
const MAX_ICS_BYTES = 1024 * 1024;

/**
 * POST /api/calendar/import — create committee meetings from an uploaded `.ics`
 * document. Body is the raw calendar text. Requires `meeting:create`.
 */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const text = await request.text();
  if (text.length === 0) {
    throw new ClientSafeError(400, 'VALIDATION_ERROR', 'Empty request body');
  }
  if (text.length > MAX_ICS_BYTES) {
    throw new ClientSafeError(413, 'PAYLOAD_TOO_LARGE', 'Calendar file too large');
  }
  const result = await withRequestTenant(() => importMeetingsFromIcs(text));
  return NextResponse.json(result);
});
