import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import {
  createCalendarEvent,
  listCalendarEvents,
  type CreateCalendarEventInput,
} from '@/domains/calendar';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET /api/calendar/events — list tenant events, optional ?from&?to ISO range.
 * POST /api/calendar/events — create event, returns { event, conflicts }.
 */
export const GET = tenantHandler(async function GET(
  request: NextRequest,
): Promise<Response> {
  const url = new URL(request.url);
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const rows = await withRequestTenant(() =>
    listCalendarEvents({
      ...(fromRaw ? { from: new Date(fromRaw) } : {}),
      ...(toRaw ? { to: new Date(toRaw) } : {}),
    }),
  );
  return NextResponse.json({ events: rows });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as CreateCalendarEventInput;
  const result = await withRequestTenant(() => createCalendarEvent(body));
  return NextResponse.json(result, { status: 201 });
});
