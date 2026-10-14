/**
 * Audit domain — append-only, tamper-evident trail.
 *
 * Import from this barrel rather than reaching into individual files:
 *   - `events`  — the closed AuditAction / ResourceType / AuditResult vocabulary.
 *   - `hash`    — canonical serialisation, SHA-256 chaining and redaction.
 *   - `service` — `recordAudit` / `recordPlatformAudit` write path.
 *   - `verify`  — `verifyChain` / `verifyAndCheckpoint` integrity tooling.
 *   - `anchor` — signed chain-head anchors stored outside the database.
 *   - `log`     — tenant-scoped viewer, formula-safe CSV export, monthly review.
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
  VerifyFromCheckpointResult,
  VerifyChainResult,
} from './verify';
export {
  AUDIT_VERIFY_PAGE_SIZE,
  AuditChainDivergenceError,
  auditChainProbe,
  checkpointVerifiedSuffix,
  createCheckpoint,
  verifyAndCheckpoint,
  verifyChain,
  verifyChainFromPages,
  verifyFromCheckpoint,
} from './verify';

export type {
  AuditLogEntry,
  AuditLogExport,
  AuditLogFilters,
  AuditLogPage,
  AuditReviewOutcome,
} from './log';
export {
  AUDIT_CSV_HEADERS,
  BREAK_GLASS_ACTION_LIKE,
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_LOG_PAGE_DEFAULT,
  AUDIT_MONTHLY_REVIEW_CHECKS,
  AUDIT_REVIEW_OUTCOMES,
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
  AnchoredChainProbe,
  AnchoredChainView,
  AuditAnchorStore,
  ChainHashes,
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
