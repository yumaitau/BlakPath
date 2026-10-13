import { customAlphabet } from 'nanoid';

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

/** Only a signed (never revoked) certificate is valid / downloadable. */
export function isValid(status: CertificateStatus): boolean {
  return status === 'signed';
}

/** What public verification established about a certificate. */
export interface VerificationFacts {
  status: CertificateStatus;
  /** Migrated from the organisation's prior system; carries no BlakPath seal. */
  issuedBeforeBlakpath: boolean;
  payloadIntact: boolean;
  signatureValid: boolean;
}

/**
 * Is the certificate currently a valid credential? Revoked is never valid. A
 * BlakPath-issued certificate must also carry an intact seal. A certificate
 * issued before BlakPath has no seal to check — it is valid as a LEGACY record
 * the organisation migrated, and verification must say so plainly.
 */
export function isValidOnVerification(facts: VerificationFacts): boolean {
  if (!isValid(facts.status)) return false;
  if (facts.issuedBeforeBlakpath) return true;
  return facts.payloadIntact && facts.signatureValid;
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

/** URL-safe verification code alphabet (matches isWellFormedVerificationCode). */
const codeGen = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  32,
);

/** Mint a fresh, unguessable public verification code. */
export function generateVerificationCode(): string {
  return codeGen();
}

/** A verification code is 24–48 url-safe chars (letters, digits, hyphen). */
export function isWellFormedVerificationCode(code: string): boolean {
  return /^[A-Za-z0-9-]{24,48}$/.test(code);
}
