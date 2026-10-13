import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { env } from '@/lib/env';
import {
  asKmsKeyAccessError,
  parseKeyArn,
  type DecryptDataKeyInput,
  type GeneratedDataKey,
  type GenerateDataKeyInput,
  type KeyProvider,
  type WrapDataKeyInput,
} from './key-provider';

/**
 * AWS KMS `GenerateDataKey` / `Decrypt`. The key ARN is sent as `KeyId` with
 * no account rewrite, so a grant or key policy in another account is enough.
 * Encryption context is `{org_id, purpose}`.
 */
export class KmsKeyProvider implements KeyProvider {
  constructor(private readonly client: KMSClient) {}

  async generateDataKey(input: GenerateDataKeyInput): Promise<GeneratedDataKey> {
    this.assertRegion(input.keyArn);
    try {
      const out = await this.client.send(
        new GenerateDataKeyCommand({
          KeyId: input.keyArn,
          KeySpec: 'AES_256',
          EncryptionContext: { ...input.encryptionContext },
        }),
      );
      if (!out.Plaintext || !out.CiphertextBlob) {
        throw new Error('KMS GenerateDataKey returned no data key');
      }
      const plaintext = Buffer.from(out.Plaintext);
      const ciphertextBlob = Buffer.from(out.CiphertextBlob);
      out.Plaintext.fill(0);
      return {
        plaintext,
        ciphertextBlob,
        keyId: out.KeyId ?? input.keyArn,
      };
    } catch (error) {
      const access = asKmsKeyAccessError(error);
      if (access) throw access;
      throw error;
    }
  }

  async wrap(input: WrapDataKeyInput): Promise<Buffer> {
    this.assertRegion(input.keyArn);
    if (input.plaintext.length !== 32) {
      throw new Error('Data key must be 32 bytes');
    }
    try {
      const out = await this.client.send(
        new EncryptCommand({
          KeyId: input.keyArn,
          Plaintext: input.plaintext,
          EncryptionContext: { ...input.encryptionContext },
        }),
      );
      if (!out.CiphertextBlob) throw new Error('KMS Encrypt returned no ciphertext');
      return Buffer.from(out.CiphertextBlob);
    } catch (error) {
      const access = asKmsKeyAccessError(error);
      if (access) throw access;
      throw error;
    }
  }

  async decrypt(input: DecryptDataKeyInput): Promise<Buffer> {
    this.assertRegion(input.keyArn);
    try {
      const out = await this.client.send(
        new DecryptCommand({
          KeyId: input.keyArn,
          CiphertextBlob: input.ciphertextBlob,
          EncryptionContext: { ...input.encryptionContext },
        }),
      );
      if (!out.Plaintext) throw new Error('KMS Decrypt returned no data key');
      const plaintext = Buffer.from(out.Plaintext);
      out.Plaintext.fill(0);
      return plaintext;
    } catch (error) {
      const access = asKmsKeyAccessError(error);
      if (access) throw access;
      throw error;
    }
  }

  private assertRegion(keyArn: string): void {
    const { region } = parseKeyArn(keyArn);
    if (region !== env.APP_REGION) {
      throw new Error(`KMS key region ${region} does not match ${env.APP_REGION}`);
    }
  }
}

const globalForKms = globalThis as unknown as {
  __blakpathEnvelopeKms?: KMSClient;
};

/** Shared client. A custom endpoint is for a local emulator only. */
export function createKmsClient(): KMSClient {
  if (!globalForKms.__blakpathEnvelopeKms) {
    globalForKms.__blakpathEnvelopeKms = new KMSClient({
      region: env.APP_REGION,
      ...(env.KMS_ENDPOINT ? { endpoint: env.KMS_ENDPOINT } : {}),
    });
  }
  return globalForKms.__blakpathEnvelopeKms;
}
