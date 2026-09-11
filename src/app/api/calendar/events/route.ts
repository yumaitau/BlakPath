import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import {
  createCalendarEvent,
  listCalendarEvents,
  type CreateCalendarEventInput,
} from '@/domains/calendar';

/**
 * GET /api/calendar/events — list tenant events, optional ?from&?to ISO range.
 * POST /api/calendar/events — create event, returns { event, conflicts }.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
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
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = (await request.json()) as CreateCalendarEventInput;
    const result = await withRequestTenant(() => createCalendarEvent(body));
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
