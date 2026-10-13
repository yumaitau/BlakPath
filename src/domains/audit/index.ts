/**
 * Audit domain — append-only, tamper-evident trail.
 *
 * Import from this barrel rather than reaching into individual files:
 *   - `events`  — the closed AuditAction / ResourceType / AuditResult vocabulary.
 *   - `hash`    — canonical serialisation, SHA-256 chaining and redaction.
 *   - `service` — `recordAudit` / `recordPlatformAudit` write path.
 *   - `verify`  — `verifyChain` / `verifyAndCheckpoint` integrity tooling.
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

export type { AuditMetaInput, RecordAuditInput, RecordedAuditEvent } from './service';
export {
  auditChainLockKey,
  auditChainWhere,
  recordAudit,
  recordPlatformAudit,
} from './service';

export type {
  AuditChainCursor,
  AuditCheckpointAnchor,
  AuditCheckpointInsert,
  AuditPageQuery,
  AuditVerificationReader,
  ChainDivergence,
  CreateCheckpointInput,
  DivergenceReason,
  StoredAuditEvent,
  VerifyAndCheckpointOptions,
  VerifyAndCheckpointResult,
  VerifyChainOptions,
  VerifyChainResult,
} from './verify';
export {
  AUDIT_VERIFY_PAGE_SIZE,
  AuditChainDivergenceError,
  createCheckpoint,
  verifyAndCheckpoint,
  verifyChain,
  verifyChainFromPages,
} from './verify';

export { PLATFORM_AUDIT_CHAIN_KEY, auditOrganisationIdFromJob } from './chain-id';
