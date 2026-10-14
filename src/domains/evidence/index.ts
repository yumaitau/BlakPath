/**
 * Evidence domain (Phase 3).
 *
 * Import from this barrel rather than reaching into individual files:
 *   - `status`  — pure lifecycle rules, servability, upload allow-list.
 *   - `schemas` — zod v4 input validation for uploads/classification/requests.
 *   - `service` — tenant-scoped, permission-checked, audited request path plus
 *     the fail-secure worker scan (`processEvidenceScan`).
 *
 * Exception: the worker-only scan sweeper is imported as
 * `@/domains/evidence/sweep`, not re-exported here. It loads storage before
 * the applications domain, and pulling it in through this barrel next to other
 * domains deadlocks the existing organisation-keys / s3 import cycle under
 * vitest's parallel module loader.
 */
export {
  ALLOWED_CONTENT_TYPES,
  EVIDENCE_STATUSES,
  MAX_EVIDENCE_BYTES,
  UPLOAD_ACCEPT,
  contentTypeAcceptable,
  inferUploadContentType,
  isAllowedContentType,
  isServable,
  isTerminalEvidenceStatus,
  uploadProblem,
  uploadSizeAcceptable,
  verifiedContentType,
  type EvidenceStatus,
} from './status';

export {
  classifyEvidenceSchema,
  onBehalfReceiptSchema,
  requestEvidenceSchema,
  requestUploadSchema,
  type ClassifyEvidenceInput,
  type RequestEvidenceInput,
  type RequestUploadInput,
} from './schemas';

export {
  classifyEvidence,
  completeUpload,
  getDownloadUrl,
  listForApplication,
  listRequestsForApplication,
  processEvidenceScan,
  requestFurtherEvidence,
  requestUpload,
  type EvidenceRequestRow,
  type EvidenceRow,
  type ProcessScanInput,
} from './service';
