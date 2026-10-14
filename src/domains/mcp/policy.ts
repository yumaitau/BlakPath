/**
 * Pure rules for external tool access.
 *
 * The HTTP route and the tool runner both call these so the gate cannot drift
 * between "is the endpoint there?" and "what may a tool return?". Nothing here
 * reads the database or the clock except the rate-window helper, which takes
 * `nowMs` from the caller.
 */

export const MCP_READ_SCOPE = 'mcp:read';
export const MCP_PII_SCOPE = 'mcp:read-pii';
export const AI_FEATURES_FLAG = 'aiFeatures';

/** One-minute fixed window for the per-key ceiling. */
export const MCP_RATE_WINDOW_MS = 60_000;

/**
 * Fields stripped unless the key holds `mcp:read-pii`.
 * Names, contact details, free-text intake, and recorded outcomes.
 */
export const MCP_WITHHELD_FIELDS: readonly string[] = [
  'applicantName',
  'applicantUserId',
  'clientId',
  'createdByUserId',
  'currentAssigneeUserId',
  'intake',
  'withdrawnReason',
  'email',
  'phone',
  'phoneNumber',
  'address',
  'dateOfBirth',
  'proposedOutcome',
  'finalOutcome',
  'title',
];

const WITHHELD = new Set<string>(MCP_WITHHELD_FIELDS);

export function hasMcpScope(permissions: ReadonlySet<string>): boolean {
  return permissions.has(MCP_READ_SCOPE) || permissions.has(MCP_PII_SCOPE);
}

export function allowsMcpPii(permissions: ReadonlySet<string>): boolean {
  return permissions.has(MCP_PII_SCOPE);
}

/**
 * HTTP status for `/api/mcp`.
 * Global flag off hides the endpoint. A tenant that has not opted in, or a key
 * without an `mcp:` scope, is refused without a body of records.
 */
export function mcpHttpStatus(input: {
  readonly globalEnabled: boolean;
  readonly tenantOptedIn: boolean;
  readonly hasMcpScope: boolean;
}): 404 | 403 | 200 {
  if (!input.globalEnabled) return 404;
  if (!input.tenantOptedIn) return 403;
  if (!input.hasMcpScope) return 403;
  return 200;
}

export function minimiseMcpValue(value: unknown, allowPii: boolean): unknown {
  if (allowPii || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((item) => minimiseMcpValue(item, false));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (WITHHELD.has(key)) continue;
    out[key] = minimiseMcpValue(child, false);
  }
  return out;
}

export function mcpRateWindow(nowMs: number): {
  bucket: number;
  retryAfterSeconds: number;
} {
  const bucket = Math.floor(nowMs / MCP_RATE_WINDOW_MS);
  const elapsed = nowMs % MCP_RATE_WINDOW_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil((MCP_RATE_WINDOW_MS - elapsed) / 1000));
  return { bucket, retryAfterSeconds };
}

export function mcpRateAllows(count: number, limit: number): boolean {
  return count <= limit;
}

export class AiFeatureChangeError extends Error {
  readonly code: 'STEP_UP_REQUIRED' | 'GOVERNANCE_REQUIRED';
  constructor(code: 'STEP_UP_REQUIRED' | 'GOVERNANCE_REQUIRED') {
    super(
      code === 'STEP_UP_REQUIRED'
        ? 'Re-authentication required'
        : 'Governance approval is required',
    );
    this.name = 'AiFeatureChangeError';
    this.code = code;
  }
}

/**
 * Enabling or disabling tenant AI features is a privileged act.
 * Enabling also requires a recorded governance reference and statement.
 */
export function assertAiFeatureChange(input: {
  readonly enabled: boolean;
  readonly stepUpVerified: boolean;
  readonly governanceReference?: string | null;
  readonly governanceStatement?: string | null;
}): void {
  if (!input.stepUpVerified) {
    throw new AiFeatureChangeError('STEP_UP_REQUIRED');
  }
  if (!input.enabled) return;
  if (!input.governanceReference?.trim() || !input.governanceStatement?.trim()) {
    throw new AiFeatureChangeError('GOVERNANCE_REQUIRED');
  }
}

/** Audit metadata for a tool call. `keyId` is the API key id, not a user id. */
export function mcpAuditAfter(input: {
  readonly keyId: string;
  readonly tool: string;
  readonly piiDisclosed: boolean;
}): {
  data: { keyId: string; tool: string; piiDisclosed: boolean };
  allow: readonly string[];
} {
  return {
    data: {
      keyId: input.keyId,
      tool: input.tool,
      piiDisclosed: input.piiDisclosed,
    },
    allow: ['keyId', 'tool', 'piiDisclosed'],
  };
}
