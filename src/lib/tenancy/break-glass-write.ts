/**
 * Raised when code under a break-glass grant tries to write.
 * The grant is read-only even if a later permission check would allow a note
 * or other mutation that only requires a read permission.
 */
export class BreakGlassWriteError extends Error {
  readonly code = 'BREAK_GLASS_READ_ONLY';
  readonly status = 403;
  constructor() {
    super('Break-glass access is read-only.');
    this.name = 'BreakGlassWriteError';
  }
}
