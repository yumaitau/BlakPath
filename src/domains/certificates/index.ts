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
export { CertificateConflictError } from './errors';

export {
  CERTIFICATE_STATUSES,
  canRevoke,
  canSign,
  caseDecidedForCertificate,
  eligibleDecision,
  isValid,
  isWellFormedVerificationCode,
  makeCertificateReference,
  type CertificateStatus,
  type EligibleDecision,
} from './status';

export {
  checkCertificateHolderSchema,
  generateCertificateSchema,
  revokeCertificateSchema,
  type CheckCertificateHolderInput,
  type GenerateCertificateInput,
  type RevokeCertificateInput,
} from './schemas';

export {
  canonicalCoaPayload,
  canonicalCoaPayloadV2,
  canonicalPayloadForVersion,
  checkCertificateHolder,
  generateCertificate,
  getDownloadUrl,
  listCertificates,
  rebuildCanonicalPayload,
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

export { loadSigningKey, recordSigningKey } from './signing-keys';
