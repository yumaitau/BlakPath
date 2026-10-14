import { TaskBoard, type BoardTask } from '@/components/board/task-board';
import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { listBoardTasks } from '@/domains/tasks';

/**
 * Work board (RSC).
 *
 * Loads the tenant's live tasks inside a DB-verified tenant context and renders
 * the drag-and-drop Kanban board. An expired session or missing organisation
 * redirects; a role without board access sees a 403 state; anything else
 * surfaces as the 500 error page.
 */
export default async function BoardPage() {
  let tasks: BoardTask[];
  try {
    tasks = await withRequestTenant(async () => {
      const rows = await listBoardTasks();
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        assigneeName: row.assigneeName,
        dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      }));
    });
  } catch (error) {
    await handlePageError(error);
    return <ForbiddenNotice title="You do not have access to the work board" />;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Work board</h1>
      <TaskBoard initialTasks={tasks} />
    </div>
  );
}
