import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import {
  CalendarConflictError,
  deleteCalendarEvent,
  updateCalendarEvent,
  type UpdateCalendarEventInput,
} from '@/domains/calendar';

/** PATCH /api/calendar/events/[id] — reschedule/edit. DELETE — soft delete. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json()) as UpdateCalendarEventInput;
    const result = await withRequestTenant(() => updateCalendarEvent(id, body));
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CalendarConflictError) {
      return NextResponse.json(
        {
          error: 'Resource conflict',
          conflicts: error.conflicts.map((c) => ({ id: c.id, title: c.title, startAt: c.startAt })),
        },
        { status: 409 },
      );
    }
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    await withRequestTenant(() => deleteCalendarEvent(id));
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
