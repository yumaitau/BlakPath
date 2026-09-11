import type { CalendarEventRow } from './service';

/** Thrown when a resource is double-booked and the tenant hard-blocks it. */
export class CalendarConflictError extends Error {
  readonly code = 'RESOURCE_CONFLICT';
  readonly status = 409;
  readonly conflicts: CalendarEventRow[];

  constructor(conflicts: CalendarEventRow[]) {
    super(`Resource is already booked by ${conflicts.length} event(s).`);
    this.name = 'CalendarConflictError';
    this.conflicts = conflicts;
  }
}
