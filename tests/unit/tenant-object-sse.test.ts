import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantKeyUnavailableError } from '@/lib/encryption/errors';
import {
  presignDownload,
  presignSseHeaders,
  tenantKeyArnFromHead,
  tenantObjectSse,
} from '@/lib/storage/s3';

const ORG = '11111111-1111-4111-8111-111111111111';
const ARN =
  'arn:aws:kms:ap-southeast-2:111111111111:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const { getOrganisationKey } = vi.hoisted(() => ({
  getOrganisationKey: vi.fn(),
}));

vi.mock('@/domains/organisation-keys', () => ({
  getOrganisationKey,
}));

beforeEach(() => {
  getOrganisationKey.mockReset();
});

describe('tenant object SSE-KMS', () => {
  it('pins the tenant key and disables the bucket key', () => {
    const sse = tenantObjectSse(ARN);
    expect(sse).toEqual({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: ARN,
      BucketKeyEnabled: false,
    });
    expect(presignSseHeaders(sse)).toEqual({
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': ARN,
      'x-amz-server-side-encryption-bucket-key-enabled': 'false',
    });
    expect(
      tenantKeyArnFromHead({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: ARN }),
    ).toBe(ARN);
  });

  it('fails closed before signing a download when the key is disabled', async () => {
    getOrganisationKey.mockResolvedValue({
      organisationId: ORG,
      kmsKeyArn: ARN,
      status: 'disabled',
    });
    await expect(
      presignDownload({
        organisationId: ORG,
        key: `${ORG}/evidence/file.pdf`,
        fileName: 'file.pdf',
      }),
    ).rejects.toBeInstanceOf(TenantKeyUnavailableError);
  });
});
