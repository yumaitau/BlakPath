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
 */
export {
  CERTIFICATE_STATUSES,
  PUBLIC_CERTIFICATE_STATUSES,
  canReissue,
  canRevoke,
  canSign,
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
  generateCertificateSchema,
  publishCertificateTemplateSchema,
  revokeCertificateSchema,
  type GenerateCertificateInput,
  type PublishCertificateTemplateInput,
  type RevokeCertificateInput,
} from './schemas';

export {
  CertificateTemplateInputError,
  CertificateTemplateRequiredError,
} from './errors';

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
  getCertificateTemplate,
  publishCertificateTemplate,
  type CertificateTemplateView,
} from './templates';

export {
  canonicalCoaPayload,
  generateCertificate,
  getDownloadUrl,
  getPreviewUrl,
  listCertificates,
  reissueCertificate,
  revokeCertificate,
  signCertificate,
  verifyCertificate,
  type CertificateRow,
  type CertificateVerification,
  type CoaCanonicalPayload,
} from './service';
