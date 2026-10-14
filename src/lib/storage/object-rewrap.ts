import {
  CopyObjectCommand,
  type CopyObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';

/**
 * Copy an object onto itself under a new SSE-KMS key. The bytes stay ciphertext.
 * The new key id is the tenant's replacement CMK, not a platform default.
 */
export function tenantObjectCopyInput(params: {
  bucket: string;
  key: string;
  kmsKeyArn: string;
}): CopyObjectCommandInput {
  if (!params.bucket || !params.key || !params.kmsKeyArn) {
    throw new Error('Object re-wrap needs a bucket, key and CMK ARN');
  }
  return {
    Bucket: params.bucket,
    Key: params.key,
    CopySource: `/${params.bucket}/${params.key}`,
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: params.kmsKeyArn,
    MetadataDirective: 'COPY',
  };
}

export async function copyObjectUnderKey(
  client: S3Client,
  params: { bucket: string; key: string; kmsKeyArn: string },
): Promise<void> {
  await client.send(new CopyObjectCommand(tenantObjectCopyInput(params)));
}
