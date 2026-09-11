import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db/client';
import {
  applications,
  certificates,
  decisions,
  organisations,
  organisationSettings,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { getApplication } from '@/domains/applications';
import { emitWebhookEventSafe } from '@/domains/webhooks';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  requireAny,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { env } from '@/lib/env';
import {
  EVIDENCE_BUCKET,
  objectKey,
  presignDownload,
  putObjectBytes,
} from '@/lib/storage/s3';
import {
  generateCertificateSchema,
  revokeCertificateSchema,
  type GenerateCertificateInput,
  type RevokeCertificateInput,
} from './schemas';
import { renderCertificatePdf } from './render';
import {
  canRevoke,
  canSign,
  eligibleDecision,
  isValid,
  makeCertificateReference,
  type CertificateStatus,
} from './status';

/**
 * Certificates service — tenant-scoped, permission-checked, audited.
 *
 * Generate a certificate from a finalised, confirmed decision; an authorised
 * human signs it (the ROUTE must additionally enforce step-up via
 * `requireRecentAuth` — the service cannot see the session); revoke if needed.
 * Only a signed, non-revoked certificate is downloadable or verifies as valid.
 * A public `verifyCertificate` needs no session — the code is the capability and
 * returns only non-personal confirmation of authenticity.
 */

export type CertificateRow = typeof certificates.$inferSelect;

/** Read-capable roles for viewing/downloading certificates. */
const CERTIFICATE_READ = [
  'certificate:generate',
  'certificate:sign',
  'certificate:revoke',
  'application:read-any',
] as const;

/** URL-safe verification code alphabet (matches isWellFormedVerificationCode). */
const codeGen = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  32,
);

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

async function loadCertificate(id: string): Promise<CertificateRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(certificates)
    .where(
      scope.where(
        certificates.organisationId,
        eq(certificates.id, id),
        isNull(certificates.deletedAt),
      ),
    )
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

/**
 * Generate a draft certificate from a finalised, confirmed decision, rendering
 * the PDF to tenant-namespaced storage. Requires `certificate:generate`.
 */
export async function generateCertificate(
  rawInput: GenerateCertificateInput,
): Promise<CertificateRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'certificate:generate');

  const input = generateCertificateSchema.parse(rawInput);
  const scope = currentScope();

  const decisionRows = await scope.db
    .select()
    .from(decisions)
    .where(
      scope.where(
        decisions.organisationId,
        eq(decisions.id, input.decisionId),
        isNull(decisions.deletedAt),
      ),
    )
    .limit(1);
  const decision = decisionRows[0];
  if (!decision) throw new AuthorizationError('POLICY_DENIED');
  if (
    !eligibleDecision({ status: decision.status, finalOutcome: decision.finalOutcome })
  ) {
    throw new AuthorizationError(
      'POLICY_DENIED',
      'A certificate can only be generated from a finalised, confirmed decision.',
    );
  }

  const appRows = await scope.db
    .select({ applicantName: applications.applicantName })
    .from(applications)
    .where(
      scope.where(
        applications.organisationId,
        eq(applications.id, decision.applicationId),
      ),
    )
    .limit(1);
  const application = must(appRows[0], 'application');

  const orgRows = await db
    .select({
      legalName: organisations.legalName,
      tradingName: organisations.tradingName,
    })
    .from(organisations)
    .where(eq(organisations.id, scope.organisationId))
    .limit(1);
  const org = must(orgRows[0], 'organisation');

  // Optional brand colour for the certificate heading (organisation-authored).
  const settingsRows = await scope.db
    .select({ branding: organisationSettings.branding })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, scope.organisationId))
    .limit(1);
  const brandColor =
    (settingsRows[0]?.branding as { primaryColor?: string } | null)?.primaryColor ?? null;

  const id = uuidv7();
  const now = new Date();
  const reference = makeCertificateReference(id, now.getUTCFullYear());
  const verificationCode = codeGen();
  const key = objectKey(scope.organisationId, 'certificates', `${id}.pdf`);

  const pdf = await renderCertificatePdf({
    organisationName: org.tradingName ?? org.legalName,
    applicantName: application.applicantName,
    reference,
    verificationCode,
    issuedOn: now.toISOString().slice(0, 10),
    verifyUrl: `${env.APP_URL}/verify/${verificationCode}`,
    brandColor,
  });
  await putObjectBytes({
    bucket: EVIDENCE_BUCKET,
    key,
    body: pdf,
    contentType: 'application/pdf',
  });
  const sha256 = createHash('sha256').update(pdf).digest('hex');

  const inserted = await scope.db
    .insert(certificates)
    .values(
      scope.insertValues({
        id,
        applicationId: decision.applicationId,
        decisionId: decision.id,
        reference,
        verificationCode,
        status: 'draft',
        pdfObjectKey: key,
        sha256,
      }),
    )
    .returning();
  const row = must(inserted[0], 'certificate');

  await recordAudit({
    action: 'certificate.generated',
    resourceType: 'certificate',
    resourceId: id,
    result: 'success',
    after: {
      data: { reference, decisionId: decision.id },
      allow: ['reference', 'decisionId'],
    },
  });
  return row;
}

/**
 * Canonical CoA payload (v1).
 *
 * The exact bytes the organisation's signing key attests. Field order is
 * fixed and values are reprojections of the stored row — verification rebuilds
 * these same bytes from the database and checks the signature, so any
 * tampering with the recorded outcome, reference, or parties breaks the seal.
 * No personal data beyond what the certificate itself already discloses.
 */
export interface CoaCanonicalPayload {
  v: 1;
  certificateId: string;
  organisationId: string;
  reference: string;
  applicationId: string;
  decisionId: string;
  outcome: string;
  verificationCode: string;
  signedAt: string;
}

export function canonicalCoaPayload(input: CoaCanonicalPayload): string {
  return JSON.stringify({
    v: 1,
    certificateId: input.certificateId,
    organisationId: input.organisationId,
    reference: input.reference,
    applicationId: input.applicationId,
    decisionId: input.decisionId,
    outcome: input.outcome,
    verificationCode: input.verificationCode,
    signedAt: input.signedAt,
  });
}

/**
 * Sign a draft certificate. Requires `certificate:sign`. NOTE: the calling route
 * or action MUST additionally enforce step-up (`requireRecentAuth`) — signing is
 * an authority-bearing act and a long-lived session must never suffice alone.
 *
 * Signing cryptographically seals the recorded outcome with the organisation's
 * KMS key. The signature covers the canonical payload only; it never creates
 * or alters the determination, which authorised humans already finalised.
 */
export async function signCertificate(id: string): Promise<CertificateRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'certificate:sign');

  const existing = await loadCertificate(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');
  if (!canSign(existing.status as CertificateStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This certificate cannot be signed.');
  }

  const scope = currentScope();
  const signedAt = new Date();
  const [decision] = await scope.db
    .select({ outcome: decisions.finalOutcome })
    .from(decisions)
    .where(scope.where(decisions.organisationId, eq(decisions.id, existing.decisionId)))
    .limit(1);
  const canonical = canonicalCoaPayload({
    v: 1,
    certificateId: id,
    organisationId: ctx.organisationId,
    reference: existing.reference,
    applicationId: existing.applicationId,
    decisionId: existing.decisionId,
    outcome: decision?.outcome ?? 'unknown',
    verificationCode: existing.verificationCode,
    signedAt: signedAt.toISOString(),
  });
  const { signCoaPayload } = await import('@/lib/kms/sign');
  const seal = await signCoaPayload(canonical);
  const updated = await scope.db
    .update(certificates)
    .set({
      status: 'signed',
      signedByUserId: ctx.userId,
      signedAt,
      payloadHash: seal.payloadHash,
      signature: seal.signatureB64,
      signingAlgorithm: seal.algorithm,
      signingKeyId: seal.keyId,
    })
    .where(scope.where(certificates.organisationId, eq(certificates.id, id)))
    .returning();
  const row = must(updated[0], 'certificate');

  await recordAudit({
    action: 'certificate.signed',
    resourceType: 'certificate',
    resourceId: id,
    result: 'success',
    reason: `sealed with ${seal.algorithm}`,
    before: { data: { status: 'draft' }, allow: ['status'] },
    after: { data: { status: 'signed' }, allow: ['status'] },
  });

  await emitWebhookEventSafe({
    organisationId: ctx.organisationId,
    event: 'certificate.signed',
    payload: {
      certificateId: id,
      reference: row.reference,
      applicationId: row.applicationId,
    },
    correlationId: ctx.correlationId,
  });
  return row;
}

/** Revoke a signed certificate. Requires `certificate:revoke`. */
export async function revokeCertificate(
  id: string,
  rawInput: RevokeCertificateInput,
): Promise<CertificateRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'certificate:revoke');

  const input = revokeCertificateSchema.parse(rawInput);
  const existing = await loadCertificate(id);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');
  if (!canRevoke(existing.status as CertificateStatus)) {
    throw new AuthorizationError(
      'POLICY_DENIED',
      'Only a signed certificate can be revoked.',
    );
  }

  const scope = currentScope();
  const updated = await scope.db
    .update(certificates)
    .set({
      status: 'revoked',
      revokedByUserId: ctx.userId,
      revokedAt: new Date(),
      revokedReason: input.reason,
    })
    .where(scope.where(certificates.organisationId, eq(certificates.id, id)))
    .returning();
  const row = must(updated[0], 'certificate');

  await recordAudit({
    action: 'certificate.revoked',
    resourceType: 'certificate',
    resourceId: id,
    result: 'success',
    reason: input.reason,
  });
  return row;
}

/** Mint a short-lived download URL for a signed, non-revoked certificate. */
export async function getDownloadUrl(
  id: string,
): Promise<{ url: string; expiresIn: number }> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), CERTIFICATE_READ);

  const row = await loadCertificate(id);
  if (!row || !isValid(row.status as CertificateStatus) || !row.pdfObjectKey) {
    throw new AuthorizationError('POLICY_DENIED');
  }

  const signed = await presignDownload({
    organisationId: ctx.organisationId,
    key: row.pdfObjectKey,
    fileName: `${row.reference}.pdf`,
  });
  await recordAudit({
    action: 'certificate.downloaded',
    resourceType: 'certificate',
    resourceId: id,
    result: 'success',
  });
  return signed;
}

/** List certificates for an application the actor may read. */
export async function listCertificates(applicationId: string): Promise<CertificateRow[]> {
  await getApplication(applicationId);
  const scope = currentScope();
  return scope.db
    .select()
    .from(certificates)
    .where(
      scope.where(
        certificates.organisationId,
        eq(certificates.applicationId, applicationId),
        isNull(certificates.deletedAt),
      ),
    )
    .orderBy(desc(certificates.createdAt));
}

/** Public, non-personal authenticity check by verification code. Unauthenticated. */
export interface CertificateVerification {
  valid: boolean;
  reference: string;
  organisationName: string;
  status: CertificateStatus;
  signedOn: string | null;
  /** Cryptographic seal check: signature matches the recorded payload. */
  signatureValid: boolean;
  /** Stored payload hash still matches the rebuilt canonical bytes. */
  payloadIntact: boolean;
}

export async function verifyCertificate(
  code: string,
): Promise<CertificateVerification | null> {
  const rows = await db
    .select({
      id: certificates.id,
      reference: certificates.reference,
      status: certificates.status,
      signedAt: certificates.signedAt,
      applicationId: certificates.applicationId,
      decisionId: certificates.decisionId,
      verificationCode: certificates.verificationCode,
      payloadHash: certificates.payloadHash,
      signature: certificates.signature,
      signingAlgorithm: certificates.signingAlgorithm,
      signingKeyId: certificates.signingKeyId,
      organisationId: certificates.organisationId,
    })
    .from(certificates)
    .where(and(eq(certificates.verificationCode, code), isNull(certificates.deletedAt)))
    .limit(1);
  const cert = rows[0];
  if (!cert) return null;

  const orgRows = await db
    .select({
      legalName: organisations.legalName,
      tradingName: organisations.tradingName,
    })
    .from(organisations)
    .where(eq(organisations.id, cert.organisationId))
    .limit(1);
  const org = orgRows[0];

  let payloadIntact = false;
  let signatureValid = false;
  if (
    cert.signedAt &&
    cert.payloadHash &&
    cert.signature &&
    cert.signingAlgorithm &&
    cert.signingKeyId
  ) {
    const decisionRows = await db
      .select({ outcome: decisions.finalOutcome })
      .from(decisions)
      .where(eq(decisions.id, cert.decisionId))
      .limit(1);
    const canonical = canonicalCoaPayload({
      v: 1,
      certificateId: cert.id,
      organisationId: cert.organisationId,
      reference: cert.reference,
      applicationId: cert.applicationId,
      decisionId: cert.decisionId,
      outcome: decisionRows[0]?.outcome ?? 'unknown',
      verificationCode: cert.verificationCode,
      signedAt: cert.signedAt.toISOString(),
    });
    const { coaPayloadHash, verifyCoaSignature } = await import('@/lib/kms/sign');
    payloadIntact = coaPayloadHash(canonical) === cert.payloadHash;
    if (payloadIntact) {
      const result = await verifyCoaSignature({
        canonical,
        signatureB64: cert.signature,
        algorithm: cert.signingAlgorithm,
        keyId: cert.signingKeyId,
      });
      signatureValid = result.signatureValid;
    }
  }

  const statusValid = isValid(cert.status as CertificateStatus);
  return {
    // A revoked certificate keeps a valid seal but is NOT a valid credential.
    valid: statusValid && payloadIntact && signatureValid,
    reference: cert.reference,
    organisationName: org?.tradingName ?? org?.legalName ?? 'Unknown organisation',
    status: cert.status as CertificateStatus,
    signedOn: cert.signedAt ? cert.signedAt.toISOString().slice(0, 10) : null,
    signatureValid,
    payloadIntact,
  };
}
