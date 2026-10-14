/**
 * Retention domain (Phase 7).
 *
 *   - `disposal` — resource type → disposal class catalogue (no legal period).
 *   - `approval` — two-person activation and purge gates.
 *   - `rules`    — pure expiry / hold / due-for-retention predicates.
 *   - `schemas`  — zod v4 policy, hold and authority-sign-off validation.
 *   - `service`  — tenant-scoped management (retention:manage) + sweep enqueue.
 *   - `sweep`    — the worker-side purge/anonymise pass (fail-safe, audited).
 *   - `register` — destruction register columns and CSV rows.
 */
export {
  CATALOGUE_VERSION,
  DISPOSAL_CLASSES,
  DISPOSAL_CLASS_BY_RESOURCE,
  DISPOSAL_CLASS_INFO,
  JURISDICTION_LABELS,
  RECORDS_JURISDICTIONS,
  disposalCatalogue,
  disposalClassFor,
  isDisposalClass,
  isRecordsJurisdiction,
  type DisposalCatalogue,
  type DisposalClass,
  type RecordsJurisdiction,
} from './disposal';

export {
  activationBlockReason,
  disposalAuthorityVerified,
  sweepBlockReason,
  type AuthoritySignoffGate,
  type SweepBlockReason,
  type SweepPolicyGate,
} from './approval';

export {
  ANONYMISED_PLACEHOLDER,
  HARD_DELETE_GRACE_DAYS,
  MIN_RETENTION_DAYS,
  RETENTION_ACTIONS,
  RETENTION_RESOURCE_TYPES,
  SWEEP_RESOURCE_TYPES,
  dueForRetention,
  isExpired,
  isOfficialApplicationStatus,
  isRetentionResourceType,
  isSweepResourceType,
  officialRecordBlocksDisposal,
  retentionCutoff,
  type RetentionAction,
  type RetentionResourceType,
  type SweepResourceType,
} from './rules';

export {
  RETENTION_DAYS_SANITY_MAX,
  createPolicySchema,
  placeHoldSchema,
  signDisposalAuthoritySchema,
  type CreatePolicyInput,
  type PlaceHoldInput,
  type SignDisposalAuthorityInput,
} from './schemas';

export { RetentionError, type RetentionErrorCode } from './errors';

export {
  DESTRUCTION_REGISTER_COLUMNS,
  destructionRegisterRows,
  type DestructionRegisterEntry,
} from './register';

export {
  activatePolicy,
  createPolicy,
  deletePolicy,
  exportDestructionRegister,
  listDestructionRegister,
  listDisposalAuthorities,
  listDisposalCatalogue,
  listHolds,
  listPolicies,
  placeHold,
  previewRetention,
  queueRetentionSweep,
  releaseHold,
  RetentionTargetError,
  signDisposalAuthority,
  type DestructionRegisterRow,
  type DisposalAuthoritySignoffRow,
  type LegalHoldRow,
  type RetentionPolicyRow,
} from './service';

export {
  previewRetentionSweep,
  processRetentionSweep,
  type RetentionPreviewItem,
  type SweepInput,
} from './sweep';
