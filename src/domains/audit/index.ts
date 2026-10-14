/**
 * Audit domain — append-only, tamper-evident trail.
 *
 * Import from this barrel rather than reaching into individual files:
 *   - `events`  — the closed AuditAction / ResourceType / AuditResult vocabulary.
 *   - `hash`    — canonical serialisation, SHA-256 chaining and redaction.
 *   - `service` — `recordAudit` / `recordPlatformAudit` write path.
 *   - `verify`  — `verifyChain` / `createCheckpoint` integrity tooling.
 *   - `anchor` — signed chain-head anchors stored outside the database.
 *   - `log`     — tenant-scoped viewer, formula-safe CSV export, monthly review.
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
  ChainDivergence,
  CreateCheckpointInput,
  DivergenceReason,
  VerifyChainOptions,
  VerifyChainResult,
} from './verify';
export { AuditChainDivergenceError, createCheckpoint, verifyChain } from './verify';

export type { AuditLogEntry, AuditLogExport, AuditLogFilters, AuditLogPage } from './log';
export {
  AUDIT_CSV_HEADERS,
  BREAK_GLASS_ACTION_LIKE,
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_LOG_PAGE_DEFAULT,
  AUDIT_MONTHLY_REVIEW_CHECKS,
  auditEventsToCsv,
  auditLogQuerySchema,
  exportAuditLog,
  listAuditLog,
  recordMonthlyAuditReview,
  recordMonthlyReviewSchema,
  tenantAuditWhere,
  toAuditQueryString,
  viewAuditChecklist,
} from './log';

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
