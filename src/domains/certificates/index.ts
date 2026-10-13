/**
 * Certificates domain (Phase 6).
 *
 *   - `status`  — pure lifecycle rules + reference/verification helpers.
 *   - `render`  — one-page PDF layout.
 *   - `schemas` — zod v4 input validation.
 *   - `service` — tenant-scoped, permission-checked, audited generate/sign/
 *     revoke/download + the public `verifyCertificate`.
 *   - `signing-keys` — stored public halves of seal keys (offline verify).
 */
export {
  CERTIFICATE_STATUSES,
  canRevoke,
  canSign,
  eligibleDecision,
  isValid,
  isWellFormedVerificationCode,
  makeCertificateReference,
  type CertificateStatus,
  type EligibleDecision,
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
  rebuildCanonicalPayload,
  revokeCertificate,
  signCertificate,
  verifyCertificate,
  type CertificateRow,
  type CertificateVerification,
  type CoaCanonicalPayload,
} from './service';

export { loadSigningKey, recordSigningKey } from './signing-keys';
