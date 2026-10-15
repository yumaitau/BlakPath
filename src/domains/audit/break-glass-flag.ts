import type { JsonValue } from './hash';

/**
 * Break-glass marker stored inside `afterMeta`.
 *
 * The audit hash already covers `afterMeta`. Putting the flag there keeps the
 * canonical event shape stable for older rows (a new hashed column would
 * break verification of the existing chain) and still makes the flag
 * tamper-evident.
 */
export interface BreakGlassAuditFlag {
  readonly requestId: string;
}

export function stampBreakGlassMeta(
  afterMeta: Record<string, JsonValue> | null,
  breakGlass: BreakGlassAuditFlag | undefined,
): Record<string, JsonValue> | null {
  if (!breakGlass) return afterMeta;
  return {
    ...(afterMeta ?? {}),
    breakGlass: true,
    breakGlassRequestId: breakGlass.requestId,
  };
}
