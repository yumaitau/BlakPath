import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import {
  assignTask,
  deleteTask,
  updateTask,
  type AssignTaskInput,
  type UpdateTaskInput,
} from '@/domains/tasks';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * PATCH  /api/tasks/[id] — edit a task, or (re)assign it. A body carrying only
 *   `assigneeUserId` routes to the assign path; anything else is a field edit.
 * DELETE /api/tasks/[id] — soft-delete a task.
 *
 * Both run inside a DB-verified tenant context; the service enforces permission.
 */
export const PATCH = tenantHandler(async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json()) as Record<string, unknown>;

  // An assignment carries exactly the assignee field (which may be null).
  const isAssignment =
    'assigneeUserId' in body &&
    Object.keys(body).every((key) => key === 'assigneeUserId');

  const row = await withRequestTenant(() =>
    isAssignment
      ? assignTask(id, body as AssignTaskInput)
      : updateTask(id, body as UpdateTaskInput),
  );
  return NextResponse.json({ task: row });
});

export const DELETE = tenantHandler(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  await withRequestTenant(() => deleteTask(id));
  return NextResponse.json({ ok: true });
});
