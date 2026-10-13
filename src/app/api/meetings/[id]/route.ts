import { NextResponse } from 'next/server';
import { getMeeting } from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** GET /api/meetings/[id] — one meeting the actor may read. Not the pack. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const meeting = await withRequestTenant(() => getMeeting(id));
    return NextResponse.json({ meeting });
  } catch (error) {
    return toErrorResponse(error);
  }
}
