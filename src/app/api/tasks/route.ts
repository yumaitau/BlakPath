import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { createTask, listTasks, type CreateTaskInput } from '@/domains/tasks';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET  /api/tasks — list the tenant's live board tasks.
 * POST /api/tasks — create a task (JSON body). Both run inside a DB-verified
 * tenant context and are permission-checked in the service layer.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const rows = await withRequestTenant(() => listTasks());
  return NextResponse.json({ tasks: rows });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body = (await request.json()) as CreateTaskInput;
  const row = await withRequestTenant(() => createTask(body));
  return NextResponse.json({ task: row }, { status: 201 });
});
