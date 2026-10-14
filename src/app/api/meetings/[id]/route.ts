import { NextResponse } from 'next/server';
import { getMeeting } from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** GET /api/meetings/[id] — one meeting the actor may read. Not the pack. */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const meeting = await withRequestTenant(() => getMeeting(id));
  return NextResponse.json({ meeting });
});
