'use client';

import { useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  BOARD_COLUMNS,
  type BoardColumn,
  type BoardPriority,
} from '@/domains/tasks/board';
import { cn } from '@/lib/utils';

/**
 * The Kanban work board.
 *
 * Cards are draggable within and between the four columns. A drop optimistically
 * updates local state and POSTs the move to the API with the destination
 * neighbours; if the request fails the board reverts to its previous state.
 *
 * PRODUCT INVARIANT: this board organises human work only. Moving a card to
 * `done` marks a task finished — it never scores or determines a person.
 */

export interface BoardTask {
  id: string;
  title: string;
  status: BoardColumn;
  priority: BoardPriority;
  assigneeName?: string | null;
  dueAt?: string | null;
}

const COLUMN_LABELS: Record<BoardColumn, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

const PRIORITY_LABELS: Record<BoardPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/** Priority chip styling. Colour is never the only signal — the label names it. */
const PRIORITY_CHIP: Record<BoardPriority, string> = {
  low: 'bg-muted text-muted-foreground',
  normal: 'bg-primary/10 text-primary',
  high: 'bg-primary/20 text-primary',
  urgent: 'bg-primary text-primary-foreground',
};

function formatDue(dueAt: string): string {
  // Pinned locale: server and browser defaults differ; unpinned formatting
  // caused hydration mismatch elsewhere (form invitations).
  return new Date(dueAt).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function TaskCard({
  task,
  onMove,
}: {
  task: BoardTask;
  onMove: (taskId: string, status: BoardColumn) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });
  const moveId = `move-task-${task.id}`;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'border-border bg-surface flex flex-col gap-2 rounded-md border p-3 text-left shadow-sm',
        isDragging && 'opacity-60',
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="focus-visible:ring-ring focus-visible:ring-offset-background cursor-grab rounded-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing"
      >
        <p className="text-primary text-sm font-medium">{task.title}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              PRIORITY_CHIP[task.priority],
            )}
          >
            {PRIORITY_LABELS[task.priority]}
          </span>
          {task.assigneeName ? (
            <span className="text-muted-foreground text-xs">{task.assigneeName}</span>
          ) : null}
          {task.dueAt ? (
            <span className="text-muted-foreground text-xs">
              Due {formatDue(task.dueAt)}
            </span>
          ) : null}
        </div>
      </div>
      <Label htmlFor={moveId} className="sr-only">
        Move {task.title} to
      </Label>
      <select
        id={moveId}
        value={task.status}
        onChange={(event) => onMove(task.id, event.target.value as BoardColumn)}
        className="border-input bg-surface text-foreground mt-1 h-9 rounded-md border px-2 text-sm"
      >
        {BOARD_COLUMNS.map((status) => (
          <option key={status} value={status}>
            {COLUMN_LABELS[status]}
          </option>
        ))}
      </select>
    </li>
  );
}

function Column({
  status,
  tasks,
  onMove,
}: {
  status: BoardColumn;
  tasks: BoardTask[];
  onMove: (taskId: string, status: BoardColumn) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section
      ref={setNodeRef}
      aria-label={COLUMN_LABELS[status]}
      className={cn(
        'border-border bg-muted/30 flex min-w-64 flex-1 flex-col gap-3 rounded-lg border p-3 transition-colors',
        isOver && 'bg-status-info-surface ring-status-info ring-2',
      )}
    >
      <header className="flex items-center justify-between">
        <h2 className="text-primary text-sm font-semibold">{COLUMN_LABELS[status]}</h2>
        <span className="text-muted-foreground text-xs">{tasks.length}</span>
      </header>
      <SortableContext
        items={tasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="flex min-h-16 flex-col gap-2">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} onMove={onMove} />
          ))}
        </ul>
      </SortableContext>
    </section>
  );
}

/** Group tasks by column, preserving their incoming order. */
function groupByColumn(tasks: BoardTask[]): Record<BoardColumn, BoardTask[]> {
  const grouped: Record<BoardColumn, BoardTask[]> = {
    todo: [],
    in_progress: [],
    blocked: [],
    done: [],
  };
  for (const task of tasks) grouped[task.status].push(task);
  return grouped;
}

export function TaskBoard({ initialTasks }: { initialTasks: BoardTask[] }) {
  const [tasks, setTasks] = useState<BoardTask[]>(initialTasks);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columns = useMemo(() => groupByColumn(tasks), [tasks]);

  const announcements: Announcements = {
    onDragStart({ active }) {
      const task = tasks.find((candidate) => candidate.id === String(active.id));
      if (!task) return 'Task picked up.';
      return `${task.title} picked up from ${COLUMN_LABELS[task.status]}. Use the arrow keys to move it, Space to drop it, or Escape to cancel.`;
    },
    onDragOver({ active, over }) {
      if (!over) return undefined;
      const task = tasks.find((candidate) => candidate.id === String(active.id));
      const targetId = String(over.id);
      const targetColumn = (BOARD_COLUMNS as readonly string[]).includes(targetId)
        ? (targetId as BoardColumn)
        : tasks.find((candidate) => candidate.id === targetId)?.status;
      if (!task || !targetColumn) return undefined;
      return `${task.title} is over ${COLUMN_LABELS[targetColumn]}.`;
    },
    onDragEnd({ active, over }) {
      const task = tasks.find((candidate) => candidate.id === String(active.id));
      if (!task) return 'Task dropped.';
      if (!over) return `${task.title} was not moved.`;
      const targetId = String(over.id);
      const targetColumn = (BOARD_COLUMNS as readonly string[]).includes(targetId)
        ? (targetId as BoardColumn)
        : tasks.find((candidate) => candidate.id === targetId)?.status;
      return targetColumn
        ? `${task.title} was moved to ${COLUMN_LABELS[targetColumn]}.`
        : `${task.title} was dropped.`;
    },
    onDragCancel({ active }) {
      const task = tasks.find((candidate) => candidate.id === String(active.id));
      return task
        ? `Moving ${task.title} was cancelled.`
        : 'Moving the task was cancelled.';
    },
  };

  /** Which column a given task id currently sits in. */
  function columnOf(id: string): BoardColumn | undefined {
    return tasks.find((task) => task.id === id)?.status;
  }

  async function persistMove(
    taskId: string,
    status: BoardColumn,
    beforeId: string | undefined,
    afterId: string | undefined,
    previous: BoardTask[],
  ): Promise<boolean> {
    try {
      const res = await fetch(`/api/tasks/${taskId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          ...(beforeId ? { beforeId } : {}),
          ...(afterId ? { afterId } : {}),
        }),
      });
      if (!res.ok) {
        setTasks(previous);
        setMessage('Could not move the task. Your change was reverted.');
        return false;
      }
      return true;
    } catch {
      setTasks(previous);
      setMessage('Could not move the task. Your change was reverted.');
      return false;
    }
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    const fromColumn = columnOf(activeId);
    if (!fromColumn) return;

    // The drop target is either another card or an (empty) column droppable.
    const toColumn = (BOARD_COLUMNS as readonly string[]).includes(overId)
      ? (overId as BoardColumn)
      : columnOf(overId);
    if (!toColumn) return;
    if (activeId === overId && fromColumn === toColumn) return;

    const previous = tasks;

    setTasks((current) => {
      const moved = current.find((task) => task.id === activeId);
      if (!moved) return current;

      // Remove the card, then re-insert it at the drop location.
      const without = current.filter((task) => task.id !== activeId);
      const destination = without.filter((task) => task.status === toColumn);
      const overIndex = destination.findIndex((task) => task.id === overId);

      const updatedCard: BoardTask = { ...moved, status: toColumn };

      if (fromColumn === toColumn) {
        // Reorder within a column: use arrayMove for a stable result.
        const columnTasks = current.filter((task) => task.status === toColumn);
        const oldIndex = columnTasks.findIndex((task) => task.id === activeId);
        const newIndex = columnTasks.findIndex((task) => task.id === overId);
        if (oldIndex === -1 || newIndex === -1) return current;
        const reordered = arrayMove(columnTasks, oldIndex, newIndex);
        const others = current.filter((task) => task.status !== toColumn);
        return [...others, ...reordered];
      }

      const insertAt = overIndex === -1 ? destination.length : overIndex;
      destination.splice(insertAt, 0, updatedCard);
      const others = without.filter((task) => task.status !== toColumn);
      return [...others, ...destination];
    });

    // Compute the destination neighbours from the post-move ordering.
    const nextColumn = tasks
      .filter((task) => task.id !== activeId && task.status === toColumn)
      .map((task) => task.id);
    let insertIndex = nextColumn.indexOf(overId);
    if (insertIndex === -1) insertIndex = nextColumn.length;
    const beforeId = insertIndex > 0 ? nextColumn[insertIndex - 1] : undefined;
    const afterId = insertIndex < nextColumn.length ? nextColumn[insertIndex] : undefined;

    setMessage(null);
    void persistMove(activeId, toColumn, beforeId, afterId, previous);
  }

  async function createNewTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newTaskTitle.trim();
    if (!title) {
      setMessage('Give the task a short name before adding it.');
      return;
    }

    setCreating(true);
    setMessage(null);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error('Unable to create task.');
      const { task } = (await response.json()) as {
        task: Omit<BoardTask, 'assigneeName'> & { dueAt: string | null };
      };
      setTasks((current) => [...current, { ...task, assigneeName: null }]);
      setNewTaskTitle('');
      setAdding(false);
    } catch {
      setMessage('We could not add that task. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  function moveTaskWithControl(taskId: string, status: BoardColumn) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status === status) return;
    const previous = tasks;
    const destinationTail = tasks
      .filter((candidate) => candidate.id !== taskId && candidate.status === status)
      .at(-1)?.id;
    setTasks((current) =>
      current.map((candidate) =>
        candidate.id === taskId ? { ...candidate, status } : candidate,
      ),
    );
    setMessage(`Moving ${task.title} to ${COLUMN_LABELS[status]}…`);
    void persistMove(taskId, status, destinationTail, undefined, previous).then(
      (persisted) => {
        if (persisted) {
          setMessage(`${task.title} moved to ${COLUMN_LABELS[status]}.`);
        }
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="border-border bg-surface flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
        <div>
          <h2 className="font-semibold">Keep work moving</h2>
          <p className="text-muted-foreground text-sm">
            Add a task, then drag it to the column that shows its progress.
          </p>
        </div>
        {!adding ? (
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            Add task
          </Button>
        ) : null}
      </div>
      {adding ? (
        <form
          onSubmit={createNewTask}
          className="border-border bg-surface flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1">
            <Label htmlFor="new-task-title" required>
              What needs to be done?
            </Label>
            <Input
              id="new-task-title"
              value={newTaskTitle}
              onChange={(event) => setNewTaskTitle(event.target.value)}
              placeholder="For example, review the new application"
              autoFocus
              disabled={creating}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={creating}>
              {creating ? 'Adding…' : 'Add task'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={creating}
              onClick={() => {
                setAdding(false);
                setNewTaskTitle('');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {message ? (
        <p
          role="status"
          className={cn(
            'text-sm font-medium',
            /^(Could not|We could not|Give the task)/.test(message)
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}
        >
          {message}
        </p>
      ) : null}
      <DndContext
        id="task-board-dnd"
        accessibility={{ announcements }}
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragEnd={onDragEnd}
      >
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          {BOARD_COLUMNS.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={columns[status]}
              onMove={moveTaskWithControl}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
