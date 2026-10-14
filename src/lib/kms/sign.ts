import {
  constants as cryptoConstants,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject,
} from 'node:crypto';
import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  type SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import { env, isProduction } from '@/lib/env';
import { logger } from '@/lib/observability/logger';

/**
 * Confirmation of Aboriginality cryptographic signing.
 *
 * A signed CoA carries a KMS-backed digital signature over a canonical payload
 * (see `canonicalCoaPayload` in the certificates domain). Anyone can then
 * verify the certificate — via the public `/verify` page — against the
 * organisation's signing key without ever seeing private key material:
 * signing happens inside KMS, verification uses the public key only.
 *
 * Seals record the RESOLVED key ARN that KMS reports it signed with — never
 * the configured alias — and the caller persists that key's public half
 * (`signing_keys`) the first time it signs. Verification is then fully
 * offline against the stored SPKI: no KMS call per `/verify` request, and an
 * alias retarget or a disabled old key never invalidates earlier seals.
 *
 * Key resolution, in order:
 *   1. `COA_SIGNING_KEY_ID` — KMS asymmetric key (RSA_2048+ or ECC_NIST_P256+,
 *      SIGN_VERIFY usage) accessed under the workload IAM role. Production.
 *   2. `COA_SIGNING_LOCAL_KEY_PEM` — PEM private key for local development and
 *      CI only. REFUSED when NODE_ENV=production: a deployable CoA signature
 *      must come from KMS, never from a checked-out secret.
 */

export const COA_SIGNING_ALGORITHMS = ['RSASSA_PSS_SHA_256', 'ECDSA_SHA_256'] as const;
export type CoaSigningAlgorithm = (typeof COA_SIGNING_ALGORITHMS)[number];

/** Key id recorded for seals made with `COA_SIGNING_LOCAL_KEY_PEM`. */
export const LOCAL_DEV_KEY_ID = 'local-dev-key';

/** Full KMS key ARN, including multi-Region (`mrk-`) keys. Never an alias. */
const KMS_KEY_ARN =
  /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/(?:mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function isKmsKeyArn(value: string): boolean {
  return KMS_KEY_ARN.test(value);
}

const globalForKms = globalThis as unknown as { __blakpathKms?: KMSClient };

function kmsClient(): KMSClient {
  globalForKms.__blakpathKms ??= new KMSClient({ region: env.S3_REGION });
  return globalForKms.__blakpathKms;
}

function localKey(): KeyObject | null {
  const raw = env.COA_SIGNING_LOCAL_KEY_PEM;
  if (!raw) return null;
  if (isProduction()) {
    throw new Error(
      'COA_SIGNING_LOCAL_KEY_PEM is refused in production — configure KMS.',
    );
  }
  // dotenv files often carry the PEM with literal \n escapes; normalise.
  const pem = raw.includes('\n') ? raw : raw.replace(/\\n/g, '\n');
  return createPrivateKey(pem);
}

function resolveAlgorithm(keyType: string, requested?: string): CoaSigningAlgorithm {
  if (requested) {
    if (!COA_SIGNING_ALGORITHMS.includes(requested as CoaSigningAlgorithm)) {
      throw new Error(`Unsupported CoA signing algorithm: ${requested}`);
    }
    return requested as CoaSigningAlgorithm;
  }
  if (keyType.includes('rsa')) return 'RSASSA_PSS_SHA_256';
  return 'ECDSA_SHA_256';
}

/** SHA-256 hex of the canonical payload — stored alongside the signature. */
export function coaPayloadHash(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** SHA-256 hex of a base64 DER SubjectPublicKeyInfo. */
export function spkiFingerprint(spkiB64: string): string {
  return createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex');
}

/** The public half of a KMS signing key, as persisted in `signing_keys`. */
export interface CoaSigningPublicKey {
  /** Resolved key ARN. */
  keyId: string;
  keySpec: string;
  /** Base64 DER SubjectPublicKeyInfo. */
  spkiB64: string;
  fingerprintSha256: string;
}

export interface CoaSignature {
  signatureB64: string;
  algorithm: CoaSigningAlgorithm;
  /** Resolved KMS key ARN, or `LOCAL_DEV_KEY_ID`. */
  keyId: string;
  payloadHash: string;
  /** KMS seals only: the signing key's public half, to persist before the seal. */
  publicKey: CoaSigningPublicKey | null;
}

function spkiKey(spkiB64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(spkiB64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function verifyWithKey(
  key: KeyObject,
  algorithm: string,
  canonical: string,
  signature: Buffer,
): boolean {
  const verifier = createVerify(algorithm === 'ECDSA_SHA_256' ? 'SHA256' : 'RSA-SHA256');
  verifier.update(canonical, 'utf8');
  const type = key.asymmetricKeyType ?? '';
  return algorithm === 'ECDSA_SHA_256' || !type.includes('rsa')
    ? verifier.verify(key, signature)
    : verifier.verify(
        { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        signature,
      );
}

/**
 * Fetch a KMS key's public half. Accepts an alias, alias ARN, key id or key
 * ARN and always returns the resolved key ARN KMS reports. Used when sealing
 * and by the operator backfill — never on the public verification path.
 */
export async function fetchKmsSigningPublicKey(
  keyIdOrAlias: string,
): Promise<CoaSigningPublicKey> {
  const out = await kmsClient().send(new GetPublicKeyCommand({ KeyId: keyIdOrAlias }));
  if (!out.PublicKey) throw new Error('KMS returned no public key.');
  if (!out.KeyId || !isKmsKeyArn(out.KeyId)) {
    throw new Error('KMS GetPublicKey did not return a key ARN.');
  }
  if (out.KeyUsage && out.KeyUsage !== 'SIGN_VERIFY') {
    throw new Error(`KMS key ${out.KeyId} is not a SIGN_VERIFY key.`);
  }
  const spkiB64 = Buffer.from(out.PublicKey).toString('base64');
  return {
    keyId: out.KeyId,
    keySpec: out.KeySpec ?? 'UNKNOWN',
    spkiB64,
    fingerprintSha256: spkiFingerprint(spkiB64),
  };
}

/** Sign the canonical payload. Returns everything the row must persist. */
export async function signCoaPayload(canonical: string): Promise<CoaSignature> {
  const payloadHash = coaPayloadHash(canonical);
  const key = localKey();
  if (key) {
    const type = key.asymmetricKeyType ?? '';
    const algorithm = resolveAlgorithm(type, env.COA_SIGNING_ALGORITHM);
    const signer = createSign(algorithm === 'ECDSA_SHA_256' ? 'SHA256' : 'RSA-SHA256');
    signer.update(canonical, 'utf8');
    const signature = type.includes('rsa')
      ? signer.sign({
          key,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        })
      : signer.sign(key);
    return {
      signatureB64: signature.toString('base64'),
      algorithm,
      keyId: LOCAL_DEV_KEY_ID,
      payloadHash,
      publicKey: null,
    };
  }

  const configured = env.COA_SIGNING_KEY_ID;
  if (!configured) {
    throw new Error(
      'CoA signing is not configured: set COA_SIGNING_KEY_ID (KMS) or, for local development only, COA_SIGNING_LOCAL_KEY_PEM.',
    );
  }
  // Resolve the configured id (often an alias) to the concrete key on every
  // seal — signing is a rare, human, step-up act — then sign with that exact
  // ARN so the public key we persist is the one that produced the signature,
  // even if the alias is retargeted mid-flight.
  const publicKey = await fetchKmsSigningPublicKey(configured);
  const verifyKey = spkiKey(publicKey.spkiB64);
  const algorithm = resolveAlgorithm(
    verifyKey.asymmetricKeyType ?? '',
    env.COA_SIGNING_ALGORITHM,
  );
  const out = await kmsClient().send(
    new SignCommand({
      KeyId: publicKey.keyId,
      Message: Buffer.from(canonical, 'utf8'),
      MessageType: 'RAW',
      SigningAlgorithm: algorithm as SigningAlgorithmSpec,
    }),
  );
  if (!out.Signature) throw new Error('KMS signing returned no signature.');
  // Persist what KMS says it signed with, and refuse anything that is not
  // the key whose public half we are about to store.
  const signedWith = out.KeyId;
  if (!signedWith || !isKmsKeyArn(signedWith) || signedWith !== publicKey.keyId) {
    throw new Error('KMS Sign did not report the resolved signing key ARN.');
  }
  const signature = Buffer.from(out.Signature);
  // Self-check: a seal that cannot verify offline must never be issued.
  if (!verifyWithKey(verifyKey, algorithm, canonical, signature)) {
    throw new Error('KMS signature does not verify against the key public half.');
  }
  logger.info({ keyId: signedWith, algorithm }, 'CoA payload signed');
  return {
    signatureB64: signature.toString('base64'),
    algorithm,
    keyId: signedWith,
    payloadHash,
    publicKey,
  };
}

export interface CoaVerification {
  signatureValid: boolean;
  payloadMatches: boolean;
}

/**
 * Verify a signature against the canonical payload using the public key only.
 * Fully offline — never calls KMS. KMS seals verify against the stored SPKI
 * (`signing_keys.public_key_spki`); `keyId === LOCAL_DEV_KEY_ID` verifies
 * against the configured local PEM. No public key → not verified.
 */
export async function verifyCoaSignature(input: {
  canonical: string;
  signatureB64: string;
  algorithm: string;
  keyId: string;
  publicKeySpki?: string | null;
}): Promise<CoaVerification> {
  const payloadMatches = true; // caller compares stored payload hash separately
  try {
    const signature = Buffer.from(input.signatureB64, 'base64');
    let key: KeyObject;
    if (input.keyId === LOCAL_DEV_KEY_ID) {
      const privateKey = localKey();
      if (!privateKey) return { signatureValid: false, payloadMatches };
      key = createPublicKey(privateKey);
    } else if (input.publicKeySpki) {
      key = spkiKey(input.publicKeySpki);
    } else {
      logger.warn(
        { keyId: input.keyId },
        'CoA seal has no stored public key — run the signing-key backfill',
      );
      return { signatureValid: false, payloadMatches };
    }
    const signatureValid = verifyWithKey(
      key,
      input.algorithm,
      input.canonical,
      signature,
    );
    return { signatureValid, payloadMatches };
  } catch (error) {
    logger.warn({ err: error }, 'CoA signature verification failed');
    return { signatureValid: false, payloadMatches };
  }
}
