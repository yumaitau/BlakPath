import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { KMSClient } from '@aws-sdk/client-kms';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KeyProvider } from '@/lib/encryption/key-provider';
import { KmsKeyProvider } from '@/lib/encryption/kms-provider';
import { LocalKeyProvider } from '@/lib/encryption/local-provider';

/**
 * Real AWS SDK against an in-process KMS stub. Gated like the other
 * integration suites. No LocalStack container is required.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

const CROSS_ACCOUNT_ARN =
  'arn:aws:kms:ap-southeast-2:222222222222:key/11111111-2222-4333-8444-555555555555';

interface Stub {
  url: string;
  seen: string[];
  close: () => Promise<void>;
}

function startStub(provider: KeyProvider): Promise<Stub> {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      KeyId?: string;
      EncryptionContext?: { org_id: string; purpose: string };
      CiphertextBlob?: string;
    };
    const target = req.headers['x-amz-target'];
    const op = (Array.isArray(target) ? target[0] : target) ?? '';
    const keyId = body.KeyId ?? '';
    seen.push(`${op} ${keyId}`);
    const context = body.EncryptionContext ?? { org_id: '', purpose: '' };
    try {
      if (op.endsWith('GenerateDataKey')) {
        const out = await provider.generateDataKey({
          keyArn: keyId,
          encryptionContext: context,
        });
        const payload = {
          Plaintext: out.plaintext.toString('base64'),
          CiphertextBlob: out.ciphertextBlob.toString('base64'),
          KeyId: keyId,
        };
        out.plaintext.fill(0);
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
        res.end(JSON.stringify(payload));
        return;
      }
      if (op.endsWith('Decrypt')) {
        const dek = await provider.decrypt({
          keyArn: keyId,
          ciphertextBlob: Buffer.from(body.CiphertextBlob ?? '', 'base64'),
          encryptionContext: context,
        });
        const payload = { Plaintext: dek.toString('base64'), KeyId: keyId };
        dek.fill(0);
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' });
      res.end(JSON.stringify({ __type: 'ValidationException', message: op }));
    } catch {
      res.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' });
      res.end(
        JSON.stringify({
          __type: 'InvalidCiphertextException',
          message: 'decrypt failed',
        }),
      );
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('KMS stub failed to listen');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        seen,
        close: () =>
          new Promise((done, reject) => {
            server.close((error) => (error ? reject(error) : done()));
          }),
      });
    });
  });
}

integration('KMS stub cross-account data keys', () => {
  let stub: Stub;
  let provider: KmsKeyProvider;

  beforeAll(async () => {
    stub = await startStub(new LocalKeyProvider(randomBytes(32)));
    provider = new KmsKeyProvider(
      new KMSClient({
        region: 'ap-southeast-2',
        endpoint: stub.url,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }),
    );
  });

  afterAll(async () => {
    await stub.close();
  });

  it('wraps and unwraps a data key for a key ARN in another account', async () => {
    const context = { org_id: 'org-cross', purpose: 'field' };
    const generated = await provider.generateDataKey({
      keyArn: CROSS_ACCOUNT_ARN,
      encryptionContext: context,
    });
    expect(generated.keyId).toBe(CROSS_ACCOUNT_ARN);
    expect(CROSS_ACCOUNT_ARN).not.toContain('959038055523');

    const dek = await provider.decrypt({
      keyArn: CROSS_ACCOUNT_ARN,
      ciphertextBlob: generated.ciphertextBlob,
      encryptionContext: context,
    });
    expect(Buffer.compare(dek, generated.plaintext)).toBe(0);
    generated.plaintext.fill(0);
    dek.fill(0);

    expect(stub.seen.some((line) => line.includes(CROSS_ACCOUNT_ARN))).toBe(true);
    expect(
      stub.seen.some(
        (line) => line.includes('GenerateDataKey') && line.includes('222222222222'),
      ),
    ).toBe(true);
  });

  it('does not unwrap when the encryption context organisation differs', async () => {
    const generated = await provider.generateDataKey({
      keyArn: CROSS_ACCOUNT_ARN,
      encryptionContext: { org_id: 'org-cross', purpose: 'field' },
    });
    generated.plaintext.fill(0);
    await expect(
      provider.decrypt({
        keyArn: CROSS_ACCOUNT_ARN,
        ciphertextBlob: generated.ciphertextBlob,
        encryptionContext: { org_id: 'org-other', purpose: 'field' },
      }),
    ).rejects.toThrow();
  });
});
