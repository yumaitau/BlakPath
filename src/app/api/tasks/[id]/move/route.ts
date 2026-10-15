import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { moveTask, type MoveTaskInput } from '@/domains/tasks';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/tasks/[id]/move — move a task to a column and slot it between its
 * dropped neighbours. Body: `{ status, beforeId?, afterId? }`. Runs inside a
 * DB-verified tenant context; the service enforces permission.
 */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json()) as MoveTaskInput;
  const row = await withRequestTenant(() => moveTask(id, body));
  return NextResponse.json({ task: row });
});
