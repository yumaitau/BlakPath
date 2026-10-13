import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { addReminder, type AddReminderInput } from '@/domains/calendar';

/** POST /api/calendar/events/[id]/reminders — set a reminder on an event. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json()) as AddReminderInput;
    const row = await withRequestTenant(() => addReminder(id, body));
    return NextResponse.json({ reminder: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
