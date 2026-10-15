import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { assignClient } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/** PATCH /api/clients/:id — assign the client to a team. */
export const PATCH = tenantHandler(async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    assignedTeamId?: string;
  } | null;
  const client = await withRequestTenant(() =>
    assignClient(id, { assignedTeamId: body?.assignedTeamId ?? '' }),
  );
  return NextResponse.json({ client });
});
