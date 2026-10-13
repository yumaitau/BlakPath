/**
 * Certificates domain (Phase 6).
 *
 *   - `status`  — pure lifecycle rules + reference/verification helpers.
 *   - `render`  — one-page PDF layout.
 *   - `schemas` — zod v4 input validation.
 *   - `service` — tenant-scoped, permission-checked, audited generate/sign/
 *     revoke/download + the public `verifyCertificate`.
 */
export {
  CERTIFICATE_STATUSES,
  canRevoke,
  canSign,
  eligibleDecision,
  generateVerificationCode,
  isValid,
  isValidOnVerification,
  isWellFormedVerificationCode,
  makeCertificateReference,
  type CertificateStatus,
  type EligibleDecision,
  type VerificationFacts,
} from './status';

export {
  generateCertificateSchema,
  revokeCertificateSchema,
  type GenerateCertificateInput,
  type RevokeCertificateInput,
} from './schemas';

export {
  canonicalCoaPayload,
  generateCertificate,
  getDownloadUrl,
  listCertificates,
  revokeCertificate,
  signCertificate,
  verifyCertificate,
  type CertificateRow,
  type CertificateVerification,
  type CoaCanonicalPayload,
} from './service';
