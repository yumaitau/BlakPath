/**
 * Audit domain — append-only, tamper-evident trail.
 *
 * Import from this barrel rather than reaching into individual files:
 *   - `events`  — the closed AuditAction / ResourceType / AuditResult vocabulary.
 *   - `hash`    — canonical serialisation, SHA-256 chaining and redaction.
 *   - `service` — `recordAudit` / `recordPlatformAudit` write path.
 *   - `verify`  — `verifyChain` / `createCheckpoint` integrity tooling.
 *   - `anchor` — signed chain-head anchors stored outside the database.
 */
export type { AuditAction, AuditResult, ResourceType } from './events';
export { AUDIT_RESULTS, isAuditResult } from './events';

export type { HashableAuditEvent, JsonValue } from './hash';
export {
  assertCodedAuditReason,
  auditReason,
  canonicalEventPayload,
  canonicalise,
  computeEventHash,
  isCodedAuditReason,
  isForbiddenAuditKey,
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
  ChainDivergence,
  CreateCheckpointInput,
  DivergenceReason,
  VerifyChainOptions,
  VerifyChainResult,
} from './verify';
export { AuditChainDivergenceError, createCheckpoint, verifyChain } from './verify';

export type {
  AnchorBody,
  AnchorMismatchReason,
  AnchorSignature,
  AnchorSigner,
  AnchoredChainView,
  AuditAnchorStore,
  SettleAuditChainResult,
  SettleAuditChainStatus,
  SignedAuditAnchor,
} from './anchor';
export {
  PLATFORM_CHAIN_ID,
  anchorDay,
  anchorObjectKey,
  assessAnchoredChain,
  auditChainId,
  canonicalAnchorBody,
  hashAnchorBody,
  parseSignedAnchor,
  settleAuditChain,
} from './anchor';
