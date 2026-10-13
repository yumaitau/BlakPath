/**
 * Individual-rights domain.
 *
 *   - `rules`       — request types, statutory due dates, escalation wording (pure).
 *   - `registry`    — where personal information lives and what erasure does to it.
 *   - `subject`     — resolve one person's rows across the schema (tenant-scoped).
 *   - `requests`    — the rights-request register (privacy:manage, audited).
 *   - `bundle`      — the subject bundle and its redactable PDF (APP 12).
 *   - `correction`  — corrections and associated statements (APP 13).
 *   - `erasure`     — anonymisation outside official records and legal holds (worker).
 *   - `offboarding` — tenant export, then human-confirmed purge (worker side too).
 */
export {
  COMPLAINT_ESCALATION_TEXT,
  RIGHTS_REQUEST_STATUSES,
  RIGHTS_REQUEST_TYPES,
  STATUTORY_PERIODS,
  canTransition,
  daysRemaining,
  escalationTextFor,
  isOverdue,
  statutoryDueDate,
  type RightsRequestStatus,
  type RightsRequestType,
} from './rules';

export {
  DATA_REGISTRY,
  ERASED_TEXT,
  SUBJECT_TABLES,
  isCorrectable,
  type DataClass,
  type TableDataPolicy,
} from './registry';

export type {
  AssociateStatementInput,
  CorrectRecordInput,
  ExportBundleInput,
  LogRequestInput,
  OffboardingConfirmInput,
  Redaction,
  UpdateRequestInput,
} from './schemas';

export {
  getRequest,
  listRequests,
  logRequest,
  updateRequest,
  type RightsRequestRow,
  type RightsRequestView,
} from './requests';

export {
  BUNDLE_EXCLUSIONS,
  BUNDLE_TABLES,
  applyRedactions,
  compileSubjectBundle,
  exportSubjectBundlePdf,
  type BundleRecord,
  type BundleSection,
  type SubjectBundle,
} from './bundle';

export {
  associateStatement,
  correctRecord,
  listStatementsFor,
  type AssociatedStatementRow,
} from './correction';

export { requestErasure, type ErasureReport } from './erasure';

export {
  confirmTenantPurge,
  getOffboardingExportUrl,
  listOffboardings,
  requestTenantOffboarding,
  type TenantOffboardingRow,
} from './offboarding';
