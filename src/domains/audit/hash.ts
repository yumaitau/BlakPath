import { createHash } from 'node:crypto';
import type { AuditAction, AuditResult, ResourceType } from './events';

/**
 * Canonical serialisation and SHA-256 hash-chaining for the audit trail.
 *
 * Tamper-evidence relies on each event committing to (a) its own content and
 * (b) the hash of the previous event in the same chain. Because the hash is
 * computed over a DETERMINISTIC serialisation (keys sorted, stable primitive
 * encoding), any later re-computation over the stored rows yields the same
 * digest — unless a byte was changed, a row was inserted, or a row was removed,
 * in which case the chain no longer verifies.
 *
 * Redaction is a first-class concern: raw document contents, secrets,
 * passwords, TOTP seeds, recovery codes, personal names, contact details,
 * free-text notes, file names and full form answers must NEVER enter
 * `beforeMeta`/`afterMeta` or `reason`, and therefore must never be hashed.
 * Use {@link redactMeta} with an explicit allowlist to prepare change metadata.
 * `reason` is a coded value ({@link auditReason}); free text stays on a
 * mutable row the code can point at.
 */

/**
 * The subset of an audit event that participates in the hash. Ordering of the
 * TypeScript fields is irrelevant — {@link canonicalise} sorts keys — but every
 * field that we want to be tamper-evident must be present here.
 */
export interface HashableAuditEvent {
  readonly id: string;
  readonly organisationId: string | null;
  /** ISO-8601 UTC timestamp string; see {@link toIsoTimestamp}. */
  readonly timestamp: string;
  readonly actorUserId: string | null;
  readonly actingRole: string | null;
  readonly sessionId: string | null;
  readonly action: AuditAction;
  readonly resourceType: ResourceType;
  readonly resourceId: string | null;
  readonly result: AuditResult;
  readonly reason: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string | null;
  readonly requestId: string | null;
  readonly beforeMeta: Readonly<Record<string, unknown>> | null;
  readonly afterMeta: Readonly<Record<string, unknown>> | null;
}

/** A JSON-serialisable value used in metadata after redaction. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Keys that must NEVER be recorded in audit metadata, regardless of allowlist.
 * Matching is case-insensitive and substring-based so variants (e.g.
 * `totpSecret`, `recovery_codes`) are caught. This is a hard denylist layered
 * beneath the allowlist for defence-in-depth.
 */
const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'secret',
  'token',
  'totp',
  'otp',
  'seed',
  'recovery',
  'backupcode',
  'backup_code',
  'privatekey',
  'private_key',
  'credential',
  'ssn',
  'documentcontent',
  'document_content',
  'filecontent',
  'file_content',
  'rawanswer',
  'raw_answer',
  'answers',
  'apikey',
  'api_key',
  // Personal data. Substring match covers applicantName, fileName, emailAddress,
  // phoneNumber, decisionNote and the same shape of key. The value stays on the
  // mutable row; the trail records that the field changed, not what it said.
  'name',
  'email',
  'phone',
  'note',
  'filename',
  'file_name',
];

const REDACTED = '[REDACTED]' as const;
/** Maximum length for any string value stored in metadata. */
const MAX_STRING_LENGTH = 2048;

/** True when `key` must not be allowlisted into audit metadata. */
export function isForbiddenAuditKey(key: string): boolean {
  const normalised = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * `reason` is a dotted code, optionally `code:recordId` where `recordId`
 * identifies the mutable row that holds free text. No spaces, no prose.
 */
const CODED_AUDIT_REASON =
  /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*(?::[A-Za-z0-9_-]{1,128})?$/;

/** Whether `reason` is safe to hash into the append-only trail. */
export function isCodedAuditReason(reason: string): boolean {
  return CODED_AUDIT_REASON.test(reason);
}

/**
 * Build a coded audit reason. Pass `recordId` only when that id is not already
 * the event's `resourceId` — it must be an id, never free text.
 */
export function auditReason(code: string, recordId?: string | null): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(code)) {
    throw new Error('Audit reason code must be a dotted identifier');
  }
  if (recordId == null || recordId === '') return code;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(recordId)) {
    throw new Error('Audit reason reference must be an id');
  }
  return `${code}:${recordId}`;
}

/**
 * Accept a coded reason or null. Reject free text. The error does not echo
 * `reason`, because that string may be the personal data we are refusing to store.
 */
export function assertCodedAuditReason(reason: string | null | undefined): string | null {
  if (reason == null || reason === '') return null;
  if (!isCodedAuditReason(reason)) {
    throw new Error('Audit reason must be a coded value, not free text');
  }
  return reason;
}

/**
 * Produce metadata safe to persist and hash.
 *
 * Only keys named in `allowlist` survive; everything else is dropped. Any
 * allowlisted key that nonetheless matches the forbidden denylist is replaced
 * with `[REDACTED]` rather than silently dropped, so reviewers can see that a
 * value existed but was withheld. Nested objects are redacted recursively;
 * arrays are passed through with element-level sanitisation. Values that are
 * not JSON-serialisable primitives/containers are coerced to strings.
 *
 * @param source Untrusted change metadata (may contain secrets).
 * @param allowlist Exact top-level keys permitted into the trail.
 */
export function redactMeta(
  source: Readonly<Record<string, unknown>> | null | undefined,
  allowlist: readonly string[],
): Record<string, JsonValue> | null {
  if (!source) {
    return null;
  }
  const allowed = new Set(allowlist);
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(source).sort()) {
    if (!allowed.has(key)) {
      continue;
    }
    if (isForbiddenAuditKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = sanitiseValue(source[key]);
  }
  return Object.keys(out).length > 0 ? out : {};
}

/**
 * Recursively sanitise a single value for safe storage. Redacts any nested
 * property whose key is forbidden and truncates oversized strings.
 */
function sanitiseValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > MAX_STRING_LENGTH ? `${s.slice(0, MAX_STRING_LENGTH)}…` : s;
  }
  if (t === 'number') {
    return Number.isFinite(value as number) ? (value as number) : null;
  }
  if (t === 'boolean') {
    return value as boolean;
  }
  if (t === 'bigint') {
    return (value as bigint).toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitiseValue(item));
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(obj).sort()) {
      result[key] = isForbiddenAuditKey(key) ? REDACTED : sanitiseValue(obj[key]);
    }
    return result;
  }
  // Functions, symbols, etc. are never serialisable — drop to null.
  return null;
}

/** Normalise a timestamp to a stable ISO-8601 UTC string for hashing. */
export function toIsoTimestamp(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

/**
 * Deterministically serialise an arbitrary JSON value with lexicographically
 * sorted object keys. This is the canonical form that the hash commits to; it
 * must be byte-stable across runs and Node versions.
 */
export function canonicalise(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    // Reject non-finite numbers up front (they cannot be canonical).
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalise(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalise(value[key] as JsonValue)}`,
  );
  return `{${entries.join(',')}}`;
}

/**
 * Build the canonical string that gets hashed for a given event, chaining in
 * the previous event's hash. A leading `prevHash` of `null` (chain genesis) is
 * encoded explicitly so the first event's digest is well-defined.
 */
export function canonicalEventPayload(
  prevHash: string | null,
  event: HashableAuditEvent,
): string {
  const payload: Record<string, JsonValue> = {
    prevHash: prevHash ?? null,
    id: event.id,
    organisationId: event.organisationId ?? null,
    timestamp: event.timestamp,
    actorUserId: event.actorUserId ?? null,
    actingRole: event.actingRole ?? null,
    sessionId: event.sessionId ?? null,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    result: event.result,
    reason: event.reason ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent ?? null,
    correlationId: event.correlationId ?? null,
    requestId: event.requestId ?? null,
    beforeMeta: (event.beforeMeta as JsonValue | undefined) ?? null,
    afterMeta: (event.afterMeta as JsonValue | undefined) ?? null,
  };
  return canonicalise(payload);
}

/**
 * Compute the SHA-256 hash for an event, chained to the previous event's hash.
 * The returned digest is lowercase hex. Recomputing this over the stored row
 * during verification must reproduce the persisted `hash` exactly.
 */
export function computeEventHash(
  prevHash: string | null,
  event: HashableAuditEvent,
): string {
  return createHash('sha256')
    .update(canonicalEventPayload(prevHash, event), 'utf8')
    .digest('hex');
}
