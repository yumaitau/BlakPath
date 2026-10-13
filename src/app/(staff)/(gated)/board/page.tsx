import { TaskBoard, type BoardTask } from '@/components/board/task-board';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { listBoardTasks } from '@/domains/tasks';

/**
 * Work board (RSC).
 *
 * Loads the tenant's live tasks inside a DB-verified tenant context and renders
 * the drag-and-drop Kanban board. If the caller is not signed in or has no
 * active organisation, a friendly prompt is shown instead of an error.
 */
export default async function BoardPage() {
  let tasks: BoardTask[] = [];
  let error: string | null = null;

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
  } catch {
    error = 'Sign in and select your organisation to view and manage the work board.';
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Work board</h1>
      {error ? (
        <p className="text-muted-foreground">{error}</p>
      ) : (
        <TaskBoard initialTasks={tasks} />
      )}
    </div>
  );
}
