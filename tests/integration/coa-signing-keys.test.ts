import { constants, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Database-backed check that sealed certificates verify offline from the
 * stored `signing_keys` public halves across an alias rotation — `/verify`
 * must make zero KMS calls. KMS itself is an in-memory fake; Postgres is real.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

const ALIAS = 'alias/blakpath-coa-signing';
const ARN_PREFIX = 'arn:aws:kms:ap-southeast-2:123456789012:key/';

integration('coa signing keys', () => {
  const keyA = {
    arn: `${ARN_PREFIX}${randomUUID()}`,
    spec: 'RSA_2048',
    ...generateKeyPairSync('rsa', { modulusLength: 2048 }),
  };
  const keyB = {
    arn: `${ARN_PREFIX}${randomUUID()}`,
    spec: 'ECC_NIST_P256',
    ...generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  };
  const kms = { aliasTarget: keyA.arn };
  let runtime: Awaited<ReturnType<typeof loadRuntime>>;
  let organisationId: string;
  let applicationId: string;

  async function loadRuntime() {
    const [client, schema, certificates, sign, sdk] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/domains/certificates'),
      import('@/lib/kms/sign'),
      import('@aws-sdk/client-kms'),
    ]);
    return { ...client, schema, certificates, sign, sdk };
  }

  function stubKms() {
    const { KMSClient, GetPublicKeyCommand, SignCommand } = runtime.sdk;
    const resolve = (id: string) => {
      const arn = id === ALIAS ? kms.aliasTarget : id;
      const key = [keyA, keyB].find((candidate) => candidate.arn === arn);
      if (!key) throw new Error(`NotFoundException: ${id}`);
      return key;
    };
    return vi
      .spyOn(KMSClient.prototype, 'send')
      .mockImplementation(async (command: unknown) => {
        if (command instanceof GetPublicKeyCommand) {
          const key = resolve(command.input.KeyId!);
          return {
            KeyId: key.arn,
            KeySpec: key.spec,
            KeyUsage: 'SIGN_VERIFY',
            PublicKey: new Uint8Array(
              key.publicKey.export({ type: 'spki', format: 'der' }),
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
                  key: key.privateKey,
                  padding: constants.RSA_PKCS1_PSS_PADDING,
                  saltLength: 32,
                })
              : signer.sign(key.privateKey);
          return { KeyId: key.arn, Signature: new Uint8Array(signature) };
        }
        throw new Error('unexpected KMS command');
      });
  }

  /**
   * Seal a certificate row the way `signCertificate` does, minus the session.
   * Each seal gets its own finalised decision: one live certificate per decision.
   */
  async function sealCertificate(): Promise<string> {
    const id = randomUUID();
    const decisionId = randomUUID();
    await runtime.db.insert(runtime.schema.decisions).values({
      id: decisionId,
      organisationId,
      applicationId,
      proposedOutcome: 'confirmed',
      finalOutcome: 'confirmed',
      status: 'finalised',
      finalisedAt: new Date(),
    });
    const verificationCode = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
    const reference = `CERT-IT-${id.slice(0, 8)}`;
    const signedAt = new Date();
    const canonical = runtime.certificates.canonicalCoaPayload({
      v: 1,
      certificateId: id,
      organisationId,
      reference,
      applicationId,
      decisionId,
      outcome: 'confirmed',
      verificationCode,
      signedAt: signedAt.toISOString(),
    });
    const seal = await runtime.sign.signCoaPayload(canonical);
    if (seal.publicKey) await runtime.certificates.recordSigningKey(seal.publicKey);
    await runtime.db.insert(runtime.schema.certificates).values({
      id,
      organisationId,
      applicationId,
      decisionId,
      reference,
      status: 'signed',
      verificationCode,
      signedAt,
      payloadHash: seal.payloadHash,
      signature: seal.signatureB64,
      signingAlgorithm: seal.algorithm,
      signingKeyId: seal.keyId,
    });
    return verificationCode;
  }

  beforeAll(async () => {
    vi.stubEnv('COA_SIGNING_KEY_ID', ALIAS);
    vi.stubEnv('COA_SIGNING_LOCAL_KEY_PEM', undefined);
    const { __resetEnvCache } = await import('@/lib/env');
    __resetEnvCache();
    runtime = await loadRuntime();
    organisationId = randomUUID();
    applicationId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Signing Key Integration Organisation',
      slug: `signing-keys-${suffix}`,
      status: 'active',
    });
    await runtime.db.insert(runtime.schema.applications).values({
      id: applicationId,
      organisationId,
      reference: `APP-IT-${suffix}`,
      applicantName: 'Name supplied for integration testing',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!runtime) return;
    const { eq, inArray } = await import('drizzle-orm');
    await runtime.db
      .delete(runtime.schema.organisations)
      .where(eq(runtime.schema.organisations.id, organisationId));
    await runtime.db
      .delete(runtime.schema.signingKeys)
      .where(inArray(runtime.schema.signingKeys.keyId, [keyA.arn, keyB.arn]));
    await runtime.sqlClient.end({ timeout: 5 });
  });

  it('verifies certificates sealed before and after an alias rotation with zero KMS calls', async () => {
    const send = stubKms();
    kms.aliasTarget = keyA.arn;
    const oldCode = await sealCertificate();
    kms.aliasTarget = keyB.arn;
    const newCode = await sealCertificate();

    const { eq } = await import('drizzle-orm');
    const stored = await runtime.db
      .select({ keyId: runtime.schema.certificates.signingKeyId })
      .from(runtime.schema.certificates)
      .where(eq(runtime.schema.certificates.organisationId, organisationId));
    expect(stored.map((row) => row.keyId).sort()).toEqual([keyA.arn, keyB.arn].sort());
    for (const row of stored) expect(runtime.sign.isKmsKeyArn(row.keyId!)).toBe(true);

    send.mockClear();
    for (const code of [oldCode, newCode]) {
      const result = await runtime.certificates.verifyCertificate(code);
      expect(result).toMatchObject({
        status: 'ok',
        verification: { valid: true, signatureValid: true, payloadIntact: true },
      });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses to seal when the stored public half disagrees with KMS', async () => {
    const { eq } = await import('drizzle-orm');
    stubKms();
    kms.aliasTarget = keyA.arn;
    await runtime.db
      .update(runtime.schema.signingKeys)
      .set({ publicKeySpki: Buffer.from('tampered').toString('base64') })
      .where(eq(runtime.schema.signingKeys.keyId, keyA.arn));
    await expect(sealCertificate()).rejects.toThrow(/does not match KMS/);
  });
});
