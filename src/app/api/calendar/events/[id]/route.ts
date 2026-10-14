import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import {
  deleteCalendarEvent,
  updateCalendarEvent,
  type UpdateCalendarEventInput,
} from '@/domains/calendar';
import { tenantHandler } from '@/lib/http/error-response';

/** PATCH /api/calendar/events/[id] — reschedule/edit. DELETE — soft delete. */
export const PATCH = tenantHandler(async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json()) as UpdateCalendarEventInput;
  const result = await withRequestTenant(() => updateCalendarEvent(id, body));
  return NextResponse.json(result);
});

export const DELETE = tenantHandler(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  await withRequestTenant(() => deleteCalendarEvent(id));
  return NextResponse.json({ deleted: true });
});
