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

describe('coa signatures (KMS, alias rotation)', () => {
  const REGION_ACCOUNT = 'arn:aws:kms:ap-southeast-2:123456789012';
  const ALIAS = 'alias/blakpath-coa-signing';
  const keyA = {
    arn: `${REGION_ACCOUNT}:key/11111111-1111-4111-8111-111111111111`,
    ...generateKeyPairSync('rsa', { modulusLength: 2048 }),
  };
  const keyB = {
    arn: `${REGION_ACCOUNT}:key/22222222-2222-4222-8222-222222222222`,
    ...generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** In-memory KMS: an alias table plus Sign/GetPublicKey semantics. */
  async function fakeKms() {
    const { KMSClient, GetPublicKeyCommand, SignCommand } =
      await import('@aws-sdk/client-kms');
    const { constants, createSign } = await import('node:crypto');
    const keys = new Map([
      [keyA.arn, { pair: keyA, spec: 'RSA_2048' }],
      [keyB.arn, { pair: keyB, spec: 'ECC_NIST_P256' }],
    ]);
    const state = { aliasTarget: keyA.arn };
    const resolve = (id: string) => {
      const arn = id === ALIAS ? state.aliasTarget : id;
      const key = keys.get(arn);
      if (!key) throw new Error(`NotFoundException: ${id}`);
      return { arn, ...key };
    };
    const impl = async (command: unknown): Promise<Record<string, unknown>> => {
      if (command instanceof GetPublicKeyCommand) {
        const key = resolve(command.input.KeyId!);
        return {
          KeyId: key.arn,
          KeySpec: key.spec,
          KeyUsage: 'SIGN_VERIFY',
          PublicKey: new Uint8Array(
            key.pair.publicKey.export({ type: 'spki', format: 'der' }),
          ),
        };
      }
      if (command instanceof SignCommand) {
        const key = resolve(command.input.KeyId!);
        const signer = createSign('SHA256');
        signer.update(Buffer.from(command.input.Message!));
        const signature =
          command.input.SigningAlgorithm === 'RSASSA_PSS_SHA_256'
            ? signer.sign({
                key: key.pair.privateKey,
                padding: constants.RSA_PKCS1_PSS_PADDING,
                saltLength: 32,
              })
            : signer.sign(key.pair.privateKey);
        return { KeyId: key.arn, Signature: new Uint8Array(signature) };
      }
      throw new Error('unexpected KMS command');
    };
    const send = vi.spyOn(KMSClient.prototype, 'send').mockImplementation(impl as never);
    return { send, state, impl };
  }

  async function freshSigning() {
    const { __resetEnvCache } = await import('@/lib/env');
    __resetEnvCache();
    return signing();
  }

  it('records the resolved key ARN, never the alias', async () => {
    vi.stubEnv('COA_SIGNING_KEY_ID', ALIAS);
    const { send } = await fakeKms();
    const { signCoaPayload, isKmsKeyArn, spkiFingerprint, canonicalCoaPayload } =
      await freshSigning();
    const seal = await signCoaPayload(payload(canonicalCoaPayload));
    expect(seal.keyId).toBe(keyA.arn);
    expect(isKmsKeyArn(seal.keyId)).toBe(true);
    expect(isKmsKeyArn(ALIAS)).toBe(false);
    expect(seal.algorithm).toBe('RSASSA_PSS_SHA_256');
    expect(seal.publicKey?.keyId).toBe(keyA.arn);
    expect(seal.publicKey?.keySpec).toBe('RSA_2048');
    expect(seal.publicKey?.fingerprintSha256).toBe(
      spkiFingerprint(seal.publicKey!.spkiB64),
    );
    // Sign is issued against the resolved ARN, so the stored public key is
    // the one that produced the signature even if the alias moves mid-seal.
    const signCall = send.mock.calls.find(
      ([command]) => (command as { input: { Message?: unknown } }).input.Message,
    );
    expect((signCall![0] as { input: { KeyId: string } }).input.KeyId).toBe(keyA.arn);
  });

  it('verifies old and new seals offline after the alias is retargeted', async () => {
    vi.stubEnv('COA_SIGNING_KEY_ID', ALIAS);
    const { send, state } = await fakeKms();
    const { signCoaPayload, verifyCoaSignature, canonicalCoaPayload } =
      await freshSigning();
    const PAYLOAD = payload(canonicalCoaPayload);

    const before = await signCoaPayload(PAYLOAD);
    state.aliasTarget = keyB.arn; // rotation: new key behind the same alias
    const after = await signCoaPayload(PAYLOAD);
    expect(before.keyId).toBe(keyA.arn);
    expect(after.keyId).toBe(keyB.arn);
    expect(after.algorithm).toBe('ECDSA_SHA_256');

    send.mockClear();
    for (const seal of [before, after]) {
      const result = await verifyCoaSignature({
        canonical: PAYLOAD,
        signatureB64: seal.signatureB64,
        algorithm: seal.algorithm,
        keyId: seal.keyId,
        publicKeySpki: seal.publicKey!.spkiB64,
      });
      expect(result.signatureValid).toBe(true);
    }
    // Cross-check: a seal never verifies against the other key's public half.
    const crossed = await verifyCoaSignature({
      canonical: PAYLOAD,
      signatureB64: before.signatureB64,
      algorithm: before.algorithm,
      keyId: before.keyId,
      publicKeySpki: after.publicKey!.spkiB64,
    });
    expect(crossed.signatureValid).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not verify a KMS seal without a stored public key, and never calls KMS', async () => {
    vi.stubEnv('COA_SIGNING_KEY_ID', ALIAS);
    const { send } = await fakeKms();
    const { signCoaPayload, verifyCoaSignature, canonicalCoaPayload } =
      await freshSigning();
    const PAYLOAD = payload(canonicalCoaPayload);
    const seal = await signCoaPayload(PAYLOAD);
    send.mockClear();
    const result = await verifyCoaSignature({
      canonical: PAYLOAD,
      signatureB64: seal.signatureB64,
      algorithm: seal.algorithm,
      keyId: seal.keyId,
      publicKeySpki: null,
    });
    expect(result.signatureValid).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a Sign response that does not name the resolved key ARN', async () => {
    vi.stubEnv('COA_SIGNING_KEY_ID', ALIAS);
    const { send, impl } = await fakeKms();
    const lying = async (command: unknown) => {
      const out = await impl(command);
      return out.Signature ? { ...out, KeyId: ALIAS } : out;
    };
    send.mockImplementation(lying as never);
    const { signCoaPayload, canonicalCoaPayload } = await freshSigning();
    await expect(signCoaPayload(payload(canonicalCoaPayload))).rejects.toThrow(
      /resolved signing key ARN/,
    );
  });

  it('recognises key ARNs, including multi-Region keys', async () => {
    const { isKmsKeyArn } = await freshSigning();
    expect(isKmsKeyArn(keyA.arn)).toBe(true);
    expect(
      isKmsKeyArn(`${REGION_ACCOUNT}:key/mrk-1234abcd12ab34cd56ef1234567890ab`),
    ).toBe(true);
    expect(isKmsKeyArn(`${REGION_ACCOUNT}:alias/blakpath-coa-signing`)).toBe(false);
    expect(isKmsKeyArn('11111111-1111-4111-8111-111111111111')).toBe(false);
  });
});
