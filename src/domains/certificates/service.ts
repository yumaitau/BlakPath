import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
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
import { recordAudit, recordPlatformAudit } from '@/domains/audit/service';
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
import { openApplicantName } from '@/lib/encryption/tenant-fields';
import {
  EVIDENCE_BUCKET,
  objectKey,
  presignDownload,
  putObjectBytes,
} from '@/lib/storage/s3';
import {
  createHolderBinding,
  dateOfBirthFromIntake,
  holderDetailsMatch,
} from './holder-binding';
import {
  checkCertificateHolderSchema,
  generateCertificateSchema,
  revokeCertificateSchema,
  type GenerateCertificateInput,
  type RevokeCertificateInput,
} from './schemas';
import { allowCertificateLookup, allowHolderCheck } from './verify-limit';
import { renderCertificatePdf } from './render';
import { CertificateConflictError } from './errors';
import {
  canRevoke,
  canSign,
  caseDecidedForCertificate,
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
 * returns only non-personal confirmation of authenticity. A separate holder
 * check compares a name the verifier types with a salted hash; it never returns
 * the recorded name.
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

/** Walk `cause` until the Postgres driver error, if any. */
function postgresError(error: unknown): { code?: string; constraint?: string } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const row = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (typeof row.code === 'string') {
      const named =
        typeof row.constraint === 'string'
          ? row.constraint
          : typeof row.constraint_name === 'string'
            ? row.constraint_name
            : null;
      return named ? { code: row.code, constraint: named } : { code: row.code };
    }
    current = row.cause;
  }
  return {};
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
 * Generate a draft certificate from a finalised, confirmed decision on a
 * decided case, rendering the PDF to tenant-namespaced storage. Requires
 * `certificate:generate`. One live certificate per decision.
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
    .select({
      applicantName: applications.applicantName,
      intake: applications.intake,
      status: applications.status,
    })
    .from(applications)
    .where(
      scope.where(
        applications.organisationId,
        eq(applications.id, decision.applicationId),
      ),
    )
    .limit(1);
  const application = must(appRows[0], 'application');
  if (!caseDecidedForCertificate(application.status)) {
    throw new AuthorizationError(
      'POLICY_DENIED',
      'A certificate can only be generated after the case is decided.',
    );
  }

  const liveRows = await scope.db
    .select({ id: certificates.id })
    .from(certificates)
    .where(
      scope.where(
        certificates.organisationId,
        eq(certificates.decisionId, decision.id),
        isNull(certificates.deletedAt),
        ne(certificates.status, 'revoked'),
      ),
    )
    .limit(1);
  if (liveRows[0]) throw new CertificateConflictError();

  const applicantName = await openApplicantName(
    scope.organisationId,
    decision.applicationId,
    application.applicantName,
  );
  const holder = createHolderBinding({
    name: applicantName,
    dateOfBirth: dateOfBirthFromIntake(application.intake),
  });

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
    applicantName,
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
    organisationId: scope.organisationId,
  });
  const sha256 = createHash('sha256').update(pdf).digest('hex');

  let inserted: CertificateRow[];
  try {
    inserted = await scope.db
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
          holderBindingSalt: holder.salt,
          holderNameHash: holder.nameHash,
          holderDobHash: holder.dobHash,
        }),
      )
      .returning();
  } catch (error) {
    const pg = postgresError(error);
    if (pg.code === '23505' && pg.constraint === 'certificates_live_decision_unique') {
      throw new CertificateConflictError();
    }
    throw error;
  }
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
 * Canonical CoA payload.
 *
 * The exact bytes the organisation's signing key attests. Field order is
 * fixed and verification rebuilds these same bytes from the database, so
 * tampering with a sealed field breaks the seal.
 *
 * Version 1 seals the reference, parties and outcome only. Those bytes must
 * stay unchanged so certificates already signed still verify.
 * Version 2 adds a salted hash of the holder name printed on the PDF, an
 * optional salted date-of-birth hash, and the PDF SHA-256. The name itself is
 * not in the payload.
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

export interface CoaCanonicalPayloadV2 {
  v: 2;
  certificateId: string;
  organisationId: string;
  reference: string;
  applicationId: string;
  decisionId: string;
  outcome: string;
  verificationCode: string;
  signedAt: string;
  holderNameHash: string;
  holderDobHash: string | null;
  pdfSha256: string;
}

export function canonicalCoaPayloadV2(input: CoaCanonicalPayloadV2): string {
  return JSON.stringify({
    v: 2,
    certificateId: input.certificateId,
    organisationId: input.organisationId,
    reference: input.reference,
    applicationId: input.applicationId,
    decisionId: input.decisionId,
    outcome: input.outcome,
    verificationCode: input.verificationCode,
    signedAt: input.signedAt,
    holderNameHash: input.holderNameHash,
    holderDobHash: input.holderDobHash,
    pdfSha256: input.pdfSha256,
  });
}

interface StoredSealInput {
  payloadVersion: string;
  certificateId: string;
  organisationId: string;
  reference: string;
  applicationId: string;
  decisionId: string;
  outcome: string;
  verificationCode: string;
  signedAt: string;
  holderNameHash: string | null;
  holderDobHash: string | null;
  pdfSha256: string | null;
}

/** Rebuild the bytes that were signed, or null when the stored row cannot. */
export function canonicalPayloadForVersion(input: StoredSealInput): string | null {
  const common = {
    certificateId: input.certificateId,
    organisationId: input.organisationId,
    reference: input.reference,
    applicationId: input.applicationId,
    decisionId: input.decisionId,
    outcome: input.outcome,
    verificationCode: input.verificationCode,
    signedAt: input.signedAt,
  };
  if (input.payloadVersion === '1') {
    return canonicalCoaPayload({ v: 1, ...common });
  }
  if (input.payloadVersion === '2' && input.holderNameHash && input.pdfSha256) {
    return canonicalCoaPayloadV2({
      v: 2,
      ...common,
      holderNameHash: input.holderNameHash,
      holderDobHash: input.holderDobHash,
      pdfSha256: input.pdfSha256,
    });
  }
  return null;
}

/**
 * Binding stored at generation matches the name rendered onto the PDF.
 * Drafts created before that column existed are bound here from the application
 * recorded at sign time.
 */
async function holderBindingForSign(existing: CertificateRow): Promise<{
  salt: string;
  nameHash: string;
  dobHash: string | null;
  pdfSha256: string;
}> {
  if (!existing.sha256) {
    throw new AuthorizationError('POLICY_DENIED', 'This certificate has no PDF to seal.');
  }
  if (existing.holderBindingSalt && existing.holderNameHash) {
    return {
      salt: existing.holderBindingSalt,
      nameHash: existing.holderNameHash,
      dobHash: existing.holderDobHash,
      pdfSha256: existing.sha256,
    };
  }
  const scope = currentScope();
  const [application] = await scope.db
    .select({
      applicantName: applications.applicantName,
      intake: applications.intake,
    })
    .from(applications)
    .where(
      scope.where(
        applications.organisationId,
        eq(applications.id, existing.applicationId),
        isNull(applications.deletedAt),
      ),
    )
    .limit(1);
  if (!application) throw new AuthorizationError('POLICY_DENIED');
  const created = createHolderBinding({
    name: application.applicantName,
    dateOfBirth: dateOfBirthFromIntake(application.intake),
  });
  return { ...created, pdfSha256: existing.sha256 };
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
  const binding = await holderBindingForSign(existing);
  const canonical = canonicalCoaPayloadV2({
    v: 2,
    certificateId: id,
    organisationId: ctx.organisationId,
    reference: existing.reference,
    applicationId: existing.applicationId,
    decisionId: existing.decisionId,
    outcome: decision?.outcome ?? 'unknown',
    verificationCode: existing.verificationCode,
    signedAt: signedAt.toISOString(),
    holderNameHash: binding.nameHash,
    holderDobHash: binding.dobHash,
    pdfSha256: binding.pdfSha256,
  });
  const { signCoaPayload } = await import('@/lib/kms/sign');
  const seal = await signCoaPayload(canonical);
  const updated = await scope.db
    .update(certificates)
    .set({
      status: 'signed',
      signedByUserId: ctx.userId,
      signedAt,
      payloadVersion: '2',
      payloadHash: seal.payloadHash,
      signature: seal.signatureB64,
      signingAlgorithm: seal.algorithm,
      signingKeyId: seal.keyId,
      holderBindingSalt: binding.salt,
      holderNameHash: binding.nameHash,
      holderDobHash: binding.dobHash,
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

/**
 * Recorded final outcome for a decision in this organisation.
 * Returns null when that organisation has no such decision.
 * The value is a human record; this lookup never derives one.
 */
export async function findDecisionOutcome(
  organisationId: string,
  decisionId: string,
): Promise<string | null> {
  const rows = await db
    .select({ outcome: decisions.finalOutcome })
    .from(decisions)
    .where(
      and(eq(decisions.id, decisionId), eq(decisions.organisationId, organisationId)),
    )
    .limit(1);
  return rows[0]?.outcome ?? null;
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
  /** Version 2 seals a holder-name hash. The name itself is not returned. */
  holderBound: boolean;
}

export interface CertificateLookupContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type CertificateLookup =
  | { status: 'rate_limited' }
  | { status: 'not_found' }
  | { status: 'ok'; verification: CertificateVerification };

interface CertificateByCode {
  id: string;
  reference: string;
  status: CertificateStatus;
  signedAt: Date | null;
  applicationId: string;
  decisionId: string;
  verificationCode: string;
  payloadHash: string | null;
  payloadVersion: string;
  signature: string | null;
  signingAlgorithm: string | null;
  signingKeyId: string | null;
  organisationId: string;
  sha256: string | null;
  holderBindingSalt: string | null;
  holderNameHash: string | null;
  holderDobHash: string | null;
}

async function findCertificateByCode(code: string): Promise<CertificateByCode | null> {
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
      payloadVersion: certificates.payloadVersion,
      signature: certificates.signature,
      signingAlgorithm: certificates.signingAlgorithm,
      signingKeyId: certificates.signingKeyId,
      organisationId: certificates.organisationId,
      sha256: certificates.sha256,
      holderBindingSalt: certificates.holderBindingSalt,
      holderNameHash: certificates.holderNameHash,
      holderDobHash: certificates.holderDobHash,
    })
    .from(certificates)
    .where(and(eq(certificates.verificationCode, code), isNull(certificates.deletedAt)))
    .limit(1);
  const cert = rows[0];
  if (!cert) return null;
  return { ...cert, status: cert.status as CertificateStatus };
}

function auditActor(ctx: CertificateLookupContext): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 512) : null,
  };
}

async function auditVerification(
  ctx: CertificateLookupContext,
  input: {
    organisationId: string | null;
    resourceId: string | null;
    result: 'success' | 'failure';
    reason: string;
  },
): Promise<void> {
  const actor = auditActor(ctx);
  const event = {
    action: 'certificate.verified' as const,
    resourceType: 'certificate' as const,
    resourceId: input.resourceId,
    result: input.result,
    reason: input.reason,
    ...actor,
  };
  if (input.organisationId) {
    await recordAudit({ ...event, organisationId: input.organisationId });
  } else {
    await recordPlatformAudit(event);
  }
}

interface SealCheck {
  payloadIntact: boolean;
  signatureValid: boolean;
  canonical: string | null;
}

async function checkSeal(cert: CertificateByCode): Promise<SealCheck> {
  if (
    !cert.signedAt ||
    !cert.payloadHash ||
    !cert.signature ||
    !cert.signingAlgorithm ||
    !cert.signingKeyId
  ) {
    return { payloadIntact: false, signatureValid: false, canonical: null };
  }
  const decisionRows = await db
    .select({ outcome: decisions.finalOutcome })
    .from(decisions)
    .where(eq(decisions.id, cert.decisionId))
    .limit(1);
  const canonical = canonicalPayloadForVersion({
    payloadVersion: cert.payloadVersion,
    certificateId: cert.id,
    organisationId: cert.organisationId,
    reference: cert.reference,
    applicationId: cert.applicationId,
    decisionId: cert.decisionId,
    outcome: decisionRows[0]?.outcome ?? 'unknown',
    verificationCode: cert.verificationCode,
    signedAt: cert.signedAt.toISOString(),
    holderNameHash: cert.holderNameHash,
    holderDobHash: cert.holderDobHash,
    pdfSha256: cert.sha256,
  });
  if (!canonical) return { payloadIntact: false, signatureValid: false, canonical: null };
  const { coaPayloadHash, verifyCoaSignature } = await import('@/lib/kms/sign');
  const payloadIntact = coaPayloadHash(canonical) === cert.payloadHash;
  if (!payloadIntact) return { payloadIntact: false, signatureValid: false, canonical };
  const result = await verifyCoaSignature({
    canonical,
    signatureB64: cert.signature,
    algorithm: cert.signingAlgorithm,
    keyId: cert.signingKeyId,
  });
  return { payloadIntact: true, signatureValid: result.signatureValid, canonical };
}

export async function verifyCertificate(
  code: string,
  ctx: CertificateLookupContext = {},
): Promise<CertificateLookup> {
  const trimmed = code.trim();
  if (!(await allowCertificateLookup(ctx.ipAddress ?? null))) {
    return { status: 'rate_limited' };
  }
  if (!trimmed || trimmed.length > 64) {
    await auditVerification(ctx, {
      organisationId: null,
      resourceId: null,
      result: 'failure',
      reason: 'not_found',
    });
    return { status: 'not_found' };
  }

  const cert = await findCertificateByCode(trimmed);
  if (!cert) {
    await auditVerification(ctx, {
      organisationId: null,
      resourceId: null,
      result: 'failure',
      reason: 'not_found',
    });
    return { status: 'not_found' };
  }

  const orgRows = await db
    .select({
      legalName: organisations.legalName,
      tradingName: organisations.tradingName,
    })
    .from(organisations)
    .where(eq(organisations.id, cert.organisationId))
    .limit(1);
  const org = orgRows[0];
  const seal = await checkSeal(cert);
  const statusValid = isValid(cert.status);

  await auditVerification(ctx, {
    organisationId: cert.organisationId,
    resourceId: cert.id,
    result: 'success',
    reason: 'lookup',
  });

  return {
    status: 'ok',
    verification: {
      // A revoked certificate keeps a valid seal but is NOT a valid credential.
      valid: statusValid && seal.payloadIntact && seal.signatureValid,
      reference: cert.reference,
      organisationName: org?.tradingName ?? org?.legalName ?? 'Unknown organisation',
      status: cert.status,
      signedOn: cert.signedAt ? cert.signedAt.toISOString().slice(0, 10) : null,
      signatureValid: seal.signatureValid,
      payloadIntact: seal.payloadIntact,
      holderBound: cert.payloadVersion === '2',
    },
  };
}

export type HolderCheckStatus =
  | 'match'
  | 'no_match'
  | 'unbound'
  | 'not_found'
  | 'rate_limited'
  | 'invalid';

/**
 * Compare details a verifier typed with the sealed holder hashes.
 * Match and no-match are the only outcomes when a version-2 seal checks out.
 * The typed name and date of birth are never stored or returned.
 */
export async function checkCertificateHolder(input: {
  code: string;
  body: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<HolderCheckStatus> {
  const ctx: CertificateLookupContext = {
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  };
  const trimmed = input.code.trim();
  if (!(await allowHolderCheck(ctx.ipAddress ?? null, trimmed || 'unknown'))) {
    return 'rate_limited';
  }
  const parsed = checkCertificateHolderSchema.safeParse(input.body);
  if (!parsed.success || !trimmed || trimmed.length > 64) {
    return 'invalid';
  }

  const cert = await findCertificateByCode(trimmed);
  if (!cert) {
    await auditVerification(ctx, {
      organisationId: null,
      resourceId: null,
      result: 'failure',
      reason: 'not_found',
    });
    return 'not_found';
  }

  const sealed =
    cert.payloadVersion === '2' &&
    Boolean(cert.holderBindingSalt && cert.holderNameHash) &&
    (cert.status === 'signed' || cert.status === 'revoked');
  if (!sealed || !cert.holderBindingSalt || !cert.holderNameHash) {
    await auditVerification(ctx, {
      organisationId: cert.organisationId,
      resourceId: cert.id,
      result: 'success',
      reason: 'holder_unbound',
    });
    return 'unbound';
  }

  const seal = await checkSeal(cert);
  const suppliedDob = parsed.data.dateOfBirth?.trim() ? parsed.data.dateOfBirth : null;
  const matched =
    seal.payloadIntact &&
    seal.signatureValid &&
    holderDetailsMatch({
      salt: cert.holderBindingSalt,
      nameHash: cert.holderNameHash,
      dobHash: cert.holderDobHash,
      name: parsed.data.name,
      dateOfBirth: suppliedDob,
    });

  await auditVerification(ctx, {
    organisationId: cert.organisationId,
    resourceId: cert.id,
    result: 'success',
    reason: matched ? 'holder_match' : 'holder_no_match',
  });
  return matched ? 'match' : 'no_match';
}
