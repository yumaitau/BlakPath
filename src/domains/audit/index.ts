/**
 * Audit domain — append-only, tamper-evident trail.
 *
 * Import from this barrel rather than reaching into individual files:
 *   - `events`  — the closed AuditAction / ResourceType / AuditResult vocabulary.
 *   - `hash`    — canonical serialisation, SHA-256 chaining and redaction.
 *   - `service` — `recordAudit` / `recordPlatformAudit` write path.
 *   - `verify`  — `verifyChain` / `createCheckpoint` integrity tooling.
 */
export type { AuditAction, AuditResult, ResourceType } from './events';
export { AUDIT_RESULTS, isAuditResult } from './events';

export type { HashableAuditEvent, JsonValue } from './hash';
export {
  canonicalEventPayload,
  canonicalise,
  computeEventHash,
  redactMeta,
  toIsoTimestamp,
} from './hash';

export type {
  AuditMetaInput,
  AuditTransaction,
  RecordAuditInput,
  RecordedAuditEvent,
} from './service';
export {
  auditChainLockKey,
  auditChainWhere,
  recordAudit,
  recordPlatformAudit,
} from './service';

export type {
  ChainDivergence,
  CreateCheckpointInput,
  DivergenceReason,
  VerifyChainOptions,
  VerifyChainResult,
} from './verify';
export { AuditChainDivergenceError, createCheckpoint, verifyChain } from './verify';
