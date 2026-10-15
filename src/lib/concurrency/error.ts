/**
 * Lost optimistic-concurrency race.
 *
 * Thrown when a conditional update matches zero rows: the status or row
 * version changed after the caller read it. `status` is 409 so route mappers
 * can return it without treating the race as a server fault.
 */
export const CONCURRENCY_CONFLICT_MESSAGE =
  'This record changed while you were working. Refresh and try again.';

export class ConcurrencyConflictError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT';
  readonly status = 409;

  constructor(message = CONCURRENCY_CONFLICT_MESSAGE) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}
