/**
 * Certificates domain (Phase 6).
 *
 *   - `status`  — pure lifecycle rules + reference/verification helpers.
 *   - `render`  — one-page PDF layout.
 *   - `schemas` — zod v4 input validation.
 *   - `template` — pure versioning, wording and public-status helpers.
 *   - `templates` — publish / read the organisation template (audited).
 *   - `service` — tenant-scoped, permission-checked, audited generate/sign/
 *     revoke/reissue/preview/download + the public `verifyCertificate`.
 *   - `signing-keys` — stored public halves of seal keys (offline verify).
 */
export {
  CertificateConflictError,
  CertificateTemplateInputError,
  CertificateTemplateRequiredError,
} from './errors';

export {
  CERTIFICATE_STATUSES,
  PUBLIC_CERTIFICATE_STATUSES,
  canReissue,
  canRevoke,
  canSign,
  caseDecidedForCertificate,
  eligibleDecision,
  isValid,
  isWellFormedVerificationCode,
  makeCertificateReference,
  publicCertificateStatus,
  toPublicCertificateView,
  type CertificateStatus,
  type EligibleDecision,
  type PublicCertificateStatus,
  type PublicCertificateView,
} from './status';

export {
  checkCertificateHolderSchema,
  generateCertificateSchema,
  publishCertificateTemplateSchema,
  revokeCertificateSchema,
  type CheckCertificateHolderInput,
  type GenerateCertificateInput,
  type PublishCertificateTemplateInput,
  type RevokeCertificateInput,
} from './schemas';

export {
  DEFAULT_CERTIFICATE_WORDING,
  detectLogoType,
  formatAbn,
  isCertificatePrintable,
  normalizeCertificateText,
  planTemplatePublish,
  supersededRevokeReason,
  templateContentHash,
  wrapCertificateLines,
} from './template';

export {
  canonicalCoaPayload,
  canonicalCoaPayloadV2,
  canonicalPayloadForVersion,
  checkCertificateHolder,
  generateCertificate,
  getDownloadUrl,
  getPreviewUrl,
  listCertificates,
  rebuildCanonicalPayload,
  reissueCertificate,
  revokeCertificate,
  signCertificate,
  verifyCertificate,
  type CertificateLookup,
  type CertificateLookupContext,
  type CertificateRow,
  type CertificateVerification,
  type CoaCanonicalPayload,
  type CoaCanonicalPayloadV2,
  type HolderCheckStatus,
} from './service';

// After `service`: it loads the applications domain before storage, which
// keeps parallel dynamic imports of this barrel from deadlocking.
export {
  getCertificateTemplate,
  publishCertificateTemplate,
  type CertificateTemplateView,
} from './templates';

export { loadSigningKey, recordSigningKey } from './signing-keys';
