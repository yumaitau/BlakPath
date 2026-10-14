import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHolderBinding,
  holderDetailsMatch,
} from '@/domains/certificates/holder-binding';

// Dynamic imports inside tests (after vi.stubEnv): the env proxy caches on
// first read, and static imports would freeze it before stubs apply.
async function signing() {
  const kms = await import('@/lib/kms/sign');
  const certs = await import('@/domains/certificates');
  return { ...kms, canonicalCoaPayload: certs.canonicalCoaPayload };
}

function payload(canonicalCoaPayload: {
  (input: {
    v: 1;
    certificateId: string;
    organisationId: string;
    reference: string;
    applicationId: string;
    decisionId: string;
    outcome: string;
    verificationCode: string;
    signedAt: string;
  }): string;
}): string {
  return canonicalCoaPayload({
    v: 1,
    certificateId: 'cert-1',
    organisationId: 'org-1',
    reference: 'CERT-2026-000001',
    applicationId: 'app-1',
    decisionId: 'dec-1',
    outcome: 'confirmed',
    verificationCode: 'ABCD1234',
    signedAt: '2026-09-11T00:00:00.000Z',
  });
}

describe('coa signatures (local key)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function freshSigning() {
    const { __resetEnvCache } = await import('@/lib/env');
    __resetEnvCache();
    return signing();
  }

  it('signs and verifies a canonical payload', async () => {
    vi.stubEnv('COA_SIGNING_LOCAL_KEY_PEM', pem);
    const { signCoaPayload, verifyCoaSignature, coaPayloadHash, canonicalCoaPayload } =
      await freshSigning();
    const PAYLOAD = payload(canonicalCoaPayload);
    const seal = await signCoaPayload(PAYLOAD);
    expect(seal.algorithm).toBe('RSASSA_PSS_SHA_256');
    expect(seal.keyId).toBe('local-dev-key');
    expect(seal.payloadHash).toBe(coaPayloadHash(PAYLOAD));
    const result = await verifyCoaSignature({
      canonical: PAYLOAD,
      signatureB64: seal.signatureB64,
      algorithm: seal.algorithm,
      keyId: seal.keyId,
    });
    expect(result.signatureValid).toBe(true);
  });

  it('rejects tampered payloads and signatures', async () => {
    vi.stubEnv('COA_SIGNING_LOCAL_KEY_PEM', pem);
    const { signCoaPayload, verifyCoaSignature, canonicalCoaPayload } =
      await freshSigning();
    const PAYLOAD = payload(canonicalCoaPayload);
    const seal = await signCoaPayload(PAYLOAD);
    const tampered = { ...seal };
    const altered = await verifyCoaSignature({
      canonical: `${PAYLOAD} `,
      signatureB64: tampered.signatureB64,
      algorithm: tampered.algorithm,
      keyId: tampered.keyId,
    });
    expect(altered.signatureValid).toBe(false);
    const badSig = await verifyCoaSignature({
      canonical: PAYLOAD,
      signatureB64: Buffer.from('nope').toString('base64'),
      algorithm: tampered.algorithm,
      keyId: tampered.keyId,
    });
    expect(badSig.signatureValid).toBe(false);
  });

  it('binds version 2 to the holder hash and still verifies version 1', async () => {
    vi.stubEnv('COA_SIGNING_LOCAL_KEY_PEM', pem);
    const { signCoaPayload, verifyCoaSignature, canonicalCoaPayload } =
      await freshSigning();
    const { canonicalCoaPayloadV2 } = await import('@/domains/certificates');
    const v1 = payload(canonicalCoaPayload);
    const v1Seal = await signCoaPayload(v1);
    expect(
      (
        await verifyCoaSignature({
          canonical: v1,
          signatureB64: v1Seal.signatureB64,
          algorithm: v1Seal.algorithm,
          keyId: v1Seal.keyId,
        })
      ).signatureValid,
    ).toBe(true);

    const binding = createHolderBinding({ name: 'Jane Smith', dateOfBirth: null });
    const shared = {
      certificateId: 'cert-1',
      organisationId: 'org-1',
      reference: 'CERT-2026-000001',
      applicationId: 'app-1',
      decisionId: 'dec-1',
      outcome: 'confirmed',
      verificationCode: 'ABCD1234',
      signedAt: '2026-09-11T00:00:00.000Z',
      holderDobHash: null,
      pdfSha256: 'ab'.repeat(32),
    };
    const v2 = canonicalCoaPayloadV2({
      v: 2,
      ...shared,
      holderNameHash: binding.nameHash,
    });
    const v2Seal = await signCoaPayload(v2);
    expect(
      (
        await verifyCoaSignature({
          canonical: v2,
          signatureB64: v2Seal.signatureB64,
          algorithm: v2Seal.algorithm,
          keyId: v2Seal.keyId,
        })
      ).signatureValid,
    ).toBe(true);
    const forged = canonicalCoaPayloadV2({
      v: 2,
      ...shared,
      holderNameHash: createHolderBinding({ name: 'Other Person', dateOfBirth: null })
        .nameHash,
    });
    expect(
      (
        await verifyCoaSignature({
          canonical: forged,
          signatureB64: v2Seal.signatureB64,
          algorithm: v2Seal.algorithm,
          keyId: v2Seal.keyId,
        })
      ).signatureValid,
    ).toBe(false);
    expect(holderDetailsMatch({ ...binding, name: 'Other Person' })).toBe(false);
    expect(holderDetailsMatch({ ...binding, name: 'Jane Smith' })).toBe(true);
  });

  it('refuses local keys in production', async () => {
    vi.stubEnv('COA_SIGNING_LOCAL_KEY_PEM', pem);
    vi.stubEnv('NODE_ENV', 'production');
    const { signCoaPayload, canonicalCoaPayload } = await freshSigning();
    const PAYLOAD = payload(canonicalCoaPayload);
    await expect(signCoaPayload(PAYLOAD)).rejects.toThrow(/refused in production/);
  });
});
