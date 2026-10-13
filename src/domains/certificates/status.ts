/**
 * Certificate status rules — pure and testable.
 *
 * A certificate is `draft` when generated, `signed` once an authorised human
 * signs it (with step-up), and `revoked` if later withdrawn. Only a signed,
 * non-revoked certificate is valid or downloadable.
 *
 * PRODUCT INVARIANT: a certificate may only be generated from a decision that
 * authorised humans FINALISED with a `confirmed` outcome. There is no path that
 * computes or infers that outcome — `eligibleDecision` merely checks the human
 * decision already recorded in Phase 5.
 */

export const CERTIFICATE_STATUSES = ['draft', 'signed', 'revoked'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

/** The minimal decision shape a certificate is generated from. */
export interface EligibleDecision {
  status: string;
  finalOutcome: string | null;
}

/** May a certificate be generated from this decision? Finalised + confirmed only. */
export function eligibleDecision(decision: EligibleDecision): boolean {
  return decision.status === 'finalised' && decision.finalOutcome === 'confirmed';
}

/** Only a draft certificate can be signed. */
export function canSign(status: CertificateStatus): boolean {
  return status === 'draft';
}

/** Only a signed certificate can be revoked. */
export function canRevoke(status: CertificateStatus): boolean {
  return status === 'signed';
}

/**
 * Only a signed certificate can be re-issued. Re-issue revokes it and links a
 * new draft. A certificate that is already revoked, including one superseded
 * earlier, cannot be re-issued again.
 */
export function canReissue(status: CertificateStatus): boolean {
  return status === 'signed';
}

/** Only a signed (never revoked) certificate is valid / downloadable. */
export function isValid(status: CertificateStatus): boolean {
  return status === 'signed';
}

/**
 * Build a human-friendly per-organisation certificate reference from a fresh id.
 * Uniqueness is guaranteed by the (organisation_id, reference) unique index; the
 * year is presentational only.
 */
export function makeCertificateReference(id: string, year: number): string {
  const tail = id.replace(/-/g, '').slice(-8).toUpperCase();
  return `CERT-${year}-${tail}`;
}

/** A verification code is 24–48 url-safe chars (letters, digits, hyphen). */
export function isWellFormedVerificationCode(code: string): boolean {
  return /^[A-Za-z0-9-]{24,48}$/.test(code);
}

/**
 * Status shown on the public verification page.
 *
 * `superseded` is not a stored lifecycle state. It is a revoked certificate
 * that has a recorded replacement. The page must show that word and nothing
 * that identifies the applicant.
 */
export const PUBLIC_CERTIFICATE_STATUSES = [
  'draft',
  'signed',
  'revoked',
  'superseded',
] as const;
export type PublicCertificateStatus = (typeof PUBLIC_CERTIFICATE_STATUSES)[number];

export function publicCertificateStatus(
  status: CertificateStatus,
  superseded: boolean,
): PublicCertificateStatus {
  if (status === 'revoked' && superseded) return 'superseded';
  return status;
}

/**
 * The only fields a public verification response may contain.
 * Callers must not spread the database row into this object.
 */
export interface PublicCertificateView {
  valid: boolean;
  reference: string;
  organisationName: string;
  status: PublicCertificateStatus;
  signedOn: string | null;
  /** Cryptographic seal check: signature matches the recorded payload. */
  signatureValid: boolean;
  /** Stored payload hash still matches the rebuilt canonical bytes. */
  payloadIntact: boolean;
}

export function toPublicCertificateView(input: {
  valid: boolean;
  reference: string;
  organisationName: string;
  status: CertificateStatus;
  superseded: boolean;
  signedOn: string | null;
  signatureValid: boolean;
  payloadIntact: boolean;
}): PublicCertificateView {
  return {
    valid: input.valid,
    reference: input.reference,
    organisationName: input.organisationName,
    status: publicCertificateStatus(input.status, input.superseded),
    signedOn: input.signedOn,
    signatureValid: input.signatureValid,
    payloadIntact: input.payloadIntact,
  };
}
