import {
  constants,
  createHash,
  createHmac,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * Thin wrappers over node:crypto for the offline key ceremony. No primitive is
 * implemented here: randomness is the OS CSPRNG, wrapping is RSA-OAEP with
 * SHA-256 (what KMS calls RSAES_OAEP_SHA_256), and fingerprints are SHA-256 or
 * HMAC-SHA-256.
 */

/** 256-bit symmetric key material, the only size KMS imports for SYMMETRIC_DEFAULT. */
export const KEY_MATERIAL_BYTES = 32;

/** KMS wrapping algorithm and the escrow key's encryption algorithm. */
export const RSA_OAEP_SHA256 = 'RSAES_OAEP_SHA_256' as const;

/** KMS offers RSA_3072 and RSA_4096 wrapping keys; RSA_2048 is refused here. */
export const MIN_RSA_BITS = 3072;

const CHECK_VALUE_LABEL = 'BlakPath key check value v1';

export function generateKeyMaterial(): Buffer {
  return randomBytes(KEY_MATERIAL_BYTES);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Key check value: HMAC-SHA-256 keyed by the material over a fixed label.
 * It identifies the material after recovery without revealing it.
 */
export function keyCheckValue(material: Uint8Array): string {
  if (material.length !== KEY_MATERIAL_BYTES) {
    throw new Error(`Key material must be ${KEY_MATERIAL_BYTES} bytes`);
  }
  return createHmac('sha256', material).update(CHECK_VALUE_LABEL).digest('hex');
}

const BASE64_TEXT = /^[A-Za-z0-9+/=\s]+$/;

/**
 * Load an RSA public key as PEM, base64 DER (the `aws kms get-public-key` and
 * `get-parameters-for-import` text output) or raw DER SubjectPublicKeyInfo.
 */
export function loadRsaPublicKey(input: Buffer, label: string): KeyObject {
  const text = input.toString('utf8').trim();
  let key: KeyObject;
  try {
    if (text.startsWith('-----BEGIN')) {
      key = createPublicKey(text);
    } else if (BASE64_TEXT.test(text)) {
      key = createPublicKey({
        key: Buffer.from(text, 'base64'),
        format: 'der',
        type: 'spki',
      });
    } else {
      key = createPublicKey({ key: input, format: 'der', type: 'spki' });
    }
  } catch {
    throw new Error(`${label} is not a readable public key`);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`${label} must be an RSA public key`);
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) {
    throw new Error(`${label} must be at least RSA-${MIN_RSA_BITS} (got ${bits} bits)`);
  }
  return key;
}

/** SHA-256 of the DER SubjectPublicKeyInfo, for witnesses to compare. */
export function publicKeyFingerprint(key: KeyObject): string {
  return sha256Hex(key.export({ format: 'der', type: 'spki' }));
}

/** RSAES_OAEP_SHA_256: OAEP with SHA-256 for both the hash and MGF1. */
export function rsaOaepSha256Encrypt(key: KeyObject, plaintext: Uint8Array): Buffer {
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    plaintext,
  );
}
