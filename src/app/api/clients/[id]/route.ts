import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { assignClient } from '@/domains/teams';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** PATCH /api/clients/:id — assign the client to a team. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      assignedTeamId?: string;
    } | null;
    const client = await withRequestTenant(() =>
      assignClient(id, { assignedTeamId: body?.assignedTeamId ?? '' }),
    );
    return NextResponse.json({ client });
  } catch (error) {
    return toErrorResponse(error);
  }
}
