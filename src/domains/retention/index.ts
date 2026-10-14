/**
 * Retention domain (Phase 7).
 *
 *   - `rules`   — pure expiry / hold / due-for-retention predicates.
 *   - `schemas` — zod v4 policy + hold validation.
 *   - `service` — tenant-scoped management (retention:manage) + sweep enqueue.
 *   - `sweep`   — the worker-side purge/anonymise pass (fail-safe, audited).
 */
export {
  ANONYMISED_PLACEHOLDER,
  HARD_DELETE_GRACE_DAYS,
  MIN_RETENTION_DAYS,
  RETENTION_ACTIONS,
  RETENTION_RESOURCE_TYPES,
  dueForRetention,
  hasDisposalAuthority,
  isExpired,
  isOfficialApplicationStatus,
  isRetentionResourceType,
  officialRecordBlocksDisposal,
  retentionCutoff,
  type RetentionAction,
  type RetentionResourceType,
} from './rules';

export {
  createPolicySchema,
  placeHoldSchema,
  type CreatePolicyInput,
  type PlaceHoldInput,
} from './schemas';

export {
  createPolicy,
  deletePolicy,
  listHolds,
  listPolicies,
  placeHold,
  previewRetention,
  queueRetentionSweep,
  releaseHold,
  RetentionTargetError,
  type LegalHoldRow,
  type RetentionPolicyRow,
} from './service';

export {
  previewRetentionSweep,
  processRetentionSweep,
  type RetentionPreviewItem,
  type SweepInput,
} from './sweep';
