import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import {
  canonicalContext,
  parseKeyArn,
  type DecryptDataKeyInput,
  type GeneratedDataKey,
  type GenerateDataKeyInput,
  type KeyProvider,
} from './key-provider';

const ALGO = 'aes-256-gcm';
const WRAP_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Deterministic stand-in for KMS. A root key derives a distinct KEK per key
 * ARN (HKDF), and the encryption context is AES-GCM additional data on the
 * wrap. Different tenants, ARNs, or contexts do not unwrap each other's DEKs.
 *
 * The root is memory-only. Production must not construct this class.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly root: Buffer;

  constructor(root: Buffer) {
    if (root.length !== 32) {
      throw new Error('Local key provider root must be 32 bytes');
    }
    this.root = Buffer.from(root);
  }

  async generateDataKey(input: GenerateDataKeyInput): Promise<GeneratedDataKey> {
    parseKeyArn(input.keyArn);
    const dek = randomBytes(32);
    const kek = this.kekFor(input.keyArn);
    try {
      return {
        plaintext: dek,
        ciphertextBlob: wrap(kek, dek, canonicalContext(input.encryptionContext)),
        keyId: input.keyArn,
      };
    } finally {
      kek.fill(0);
    }
  }

  async decrypt(input: DecryptDataKeyInput): Promise<Buffer> {
    parseKeyArn(input.keyArn);
    const kek = this.kekFor(input.keyArn);
    try {
      return unwrap(kek, input.ciphertextBlob, canonicalContext(input.encryptionContext));
    } finally {
      kek.fill(0);
    }
  }

  private kekFor(keyArn: string): Buffer {
    return Buffer.from(
      hkdfSync(
        'sha256',
        this.root,
        Buffer.from('blakpath.local-kms.v1'),
        Buffer.from(keyArn),
        32,
      ),
    );
  }
}

function wrap(kek: Buffer, dek: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, kek, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([WRAP_VERSION]), iv, tag, data]);
}

function unwrap(kek: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== WRAP_VERSION) {
    throw new Error('Malformed wrapped data key');
  }
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const data = blob.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, kek, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
