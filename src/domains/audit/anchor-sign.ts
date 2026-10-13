import {
  constants as cryptoConstants,
  createHmac,
  createPublicKey,
  createVerify,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  type SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import { env, isProduction } from '@/lib/env';
import type { AnchorSigner } from './anchor';

/**
 * Anchor signatures. Production signs inside KMS. Other environments use HMAC
 * so a test or a local worker can still seal a head without a key ARN. The
 * HMAC key is not accepted in production.
 */

const HMAC_ALGORITHM = 'HMAC-SHA256';
const HMAC_KEY_ID = 'hmac:audit-anchor';

const globalForAnchorKms = globalThis as unknown as {
  __blakpathAnchorKms?: KMSClient;
  __blakpathAnchorPub?: Map<string, { at: number; pem: string }>;
};

function kmsClient(): KMSClient {
  globalForAnchorKms.__blakpathAnchorKms ??= new KMSClient({ region: env.S3_REGION });
  return globalForAnchorKms.__blakpathAnchorKms;
}

function publicKeys(): Map<string, { at: number; pem: string }> {
  globalForAnchorKms.__blakpathAnchorPub ??= new Map();
  return globalForAnchorKms.__blakpathAnchorPub;
}

export function createHmacAnchorSigner(secret: string): AnchorSigner {
  if (secret.length < 32) {
    throw new Error('Audit anchor HMAC secret must be at least 32 characters');
  }
  return {
    keyId: HMAC_KEY_ID,
    algorithm: HMAC_ALGORITHM,
    async sign(canonical) {
      return {
        signatureB64: createHmac('sha256', secret)
          .update(canonical, 'utf8')
          .digest('base64'),
        algorithm: HMAC_ALGORITHM,
        keyId: HMAC_KEY_ID,
      };
    },
    async verify(canonical, signatureB64, keyId, algorithm) {
      if (keyId !== HMAC_KEY_ID || algorithm !== HMAC_ALGORITHM) return false;
      const expected = createHmac('sha256', secret).update(canonical, 'utf8').digest();
      const got = Buffer.from(signatureB64, 'base64');
      if (got.length !== expected.length) return false;
      return timingSafeEqual(got, expected);
    },
  };
}

async function publicKeyPem(keyId: string): Promise<string> {
  const cached = publicKeys().get(keyId);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.pem;
  const out = await kmsClient().send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!out.PublicKey) throw new Error('KMS returned no public key for the audit anchor.');
  const body = Buffer.from(out.PublicKey)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n');
  const pem = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
  publicKeys().set(keyId, { at: Date.now(), pem });
  return pem;
}

function algorithmFor(key: KeyObject): 'RSASSA_PSS_SHA_256' | 'ECDSA_SHA_256' {
  return (key.asymmetricKeyType ?? '').includes('rsa')
    ? 'RSASSA_PSS_SHA_256'
    : 'ECDSA_SHA_256';
}

export function createKmsAnchorSigner(keyId: string): AnchorSigner {
  return {
    keyId,
    algorithm: 'RSASSA_PSS_SHA_256',
    async sign(canonical) {
      const pem = await publicKeyPem(keyId);
      const algorithm = algorithmFor(createPublicKey(pem));
      const out = await kmsClient().send(
        new SignCommand({
          KeyId: keyId,
          Message: Buffer.from(canonical, 'utf8'),
          MessageType: 'RAW',
          SigningAlgorithm: algorithm as SigningAlgorithmSpec,
        }),
      );
      if (!out.Signature)
        throw new Error('KMS signing returned no audit anchor signature.');
      return {
        signatureB64: Buffer.from(out.Signature).toString('base64'),
        algorithm,
        keyId,
      };
    },
    async verify(canonical, signatureB64, signatureKeyId, algorithm) {
      if (algorithm !== 'RSASSA_PSS_SHA_256' && algorithm !== 'ECDSA_SHA_256') {
        return false;
      }
      try {
        const key = createPublicKey(await publicKeyPem(signatureKeyId));
        const verifier = createVerify(
          algorithm === 'ECDSA_SHA_256' ? 'SHA256' : 'RSA-SHA256',
        );
        verifier.update(canonical, 'utf8');
        const signature = Buffer.from(signatureB64, 'base64');
        if (algorithm === 'RSASSA_PSS_SHA_256') {
          return verifier.verify(
            {
              key,
              padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
              saltLength: 32,
            },
            signature,
          );
        }
        return verifier.verify(key, signature);
      } catch {
        return false;
      }
    },
  };
}

export function loadAnchorSigner(): AnchorSigner {
  const keyId = env.AUDIT_ANCHOR_SIGNING_KEY_ID;
  if (keyId) return createKmsAnchorSigner(keyId);
  if (isProduction()) {
    throw new Error('AUDIT_ANCHOR_SIGNING_KEY_ID is required in production');
  }
  const secret = env.AUDIT_ANCHOR_HMAC_KEY ?? env.ENCRYPTION_MASTER_KEY;
  return createHmacAnchorSigner(secret);
}
