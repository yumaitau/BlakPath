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
 * Key resolution, in order:
 *   1. `COA_SIGNING_KEY_ID` — KMS asymmetric key (RSA_2048+ or ECC_NIST_P256+,
 *      SIGN_VERIFY usage) accessed under the workload IAM role. Production.
 *   2. `COA_SIGNING_LOCAL_KEY_PEM` — PEM private key for local development and
 *      CI only. REFUSED when NODE_ENV=production: a deployable CoA signature
 *      must come from KMS, never from a checked-out secret.
 */

export const COA_SIGNING_ALGORITHMS = ['RSASSA_PSS_SHA_256', 'ECDSA_SHA_256'] as const;
export type CoaSigningAlgorithm = (typeof COA_SIGNING_ALGORITHMS)[number];

const globalForKms = globalThis as unknown as {
  __blakpathKms?: KMSClient;
  __blakpathCoaPubkey?: { keyId: string; at: number; pem: string };
};

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

export interface CoaSignature {
  signatureB64: string;
  algorithm: CoaSigningAlgorithm;
  keyId: string;
  payloadHash: string;
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
      keyId: 'local-dev-key',
      payloadHash,
    };
  }

  const keyId = env.COA_SIGNING_KEY_ID;
  if (!keyId) {
    throw new Error(
      'CoA signing is not configured: set COA_SIGNING_KEY_ID (KMS) or, for local development only, COA_SIGNING_LOCAL_KEY_PEM.',
    );
  }
  // Algorithm resolved after DescribeKey tells us the key type; request KMS
  // default first via a cheap public-key fetch (cached below).
  const pem = await getCoaPublicKeyPem(keyId);
  const pub = createPublicKey(pem);
  const algorithm = resolveAlgorithm(
    pub.asymmetricKeyType ?? '',
    env.COA_SIGNING_ALGORITHM,
  );
  const out = await kmsClient().send(
    new SignCommand({
      KeyId: keyId,
      Message: Buffer.from(canonical, 'utf8'),
      MessageType: 'RAW',
      SigningAlgorithm: algorithm as SigningAlgorithmSpec,
    }),
  );
  if (!out.Signature) throw new Error('KMS signing returned no signature.');
  logger.info({ keyId, algorithm }, 'CoA payload signed');
  return {
    signatureB64: Buffer.from(out.Signature).toString('base64'),
    algorithm,
    keyId,
    payloadHash,
  };
}

/** Fetch (and cache for 1h) the public key PEM for a KMS key. */
export async function getCoaPublicKeyPem(keyId: string): Promise<string> {
  const cached = globalForKms.__blakpathCoaPubkey;
  if (cached && cached.keyId === keyId && Date.now() - cached.at < 3_600_000) {
    return cached.pem;
  }
  const out = await kmsClient().send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!out.PublicKey) throw new Error('KMS returned no public key.');
  const pem = Buffer.from(out.PublicKey)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n');
  const wrapped = `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----\n`;
  globalForKms.__blakpathCoaPubkey = { keyId, at: Date.now(), pem: wrapped };
  return wrapped;
}

export interface CoaVerification {
  signatureValid: boolean;
  payloadMatches: boolean;
}

/**
 * Verify a signature against the canonical payload using the public key only.
 * `keyId === 'local-dev-key'` verifies against the configured local PEM.
 */
export async function verifyCoaSignature(input: {
  canonical: string;
  signatureB64: string;
  algorithm: string;
  keyId: string;
}): Promise<CoaVerification> {
  const payloadMatches = true; // caller compares stored payload hash separately
  try {
    const verifier = createVerify(
      input.algorithm === 'ECDSA_SHA_256' ? 'SHA256' : 'RSA-SHA256',
    );
    verifier.update(input.canonical, 'utf8');
    const signature = Buffer.from(input.signatureB64, 'base64');
    let key: KeyObject;
    if (input.keyId === 'local-dev-key') {
      const privateKey = localKey();
      if (!privateKey) return { signatureValid: false, payloadMatches };
      key = createPublicKey(privateKey);
    } else {
      key = createPublicKey(await getCoaPublicKeyPem(input.keyId));
    }
    const type = key.asymmetricKeyType ?? '';
    const signatureValid =
      input.algorithm === 'ECDSA_SHA_256' || !type.includes('rsa')
        ? verifier.verify(key, signature)
        : verifier.verify(
            { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
            signature,
          );
    return { signatureValid, payloadMatches };
  } catch (error) {
    logger.warn({ err: error }, 'CoA signature verification failed');
    return { signatureValid: false, payloadMatches };
  }
}
