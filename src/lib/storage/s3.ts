import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import { lifecycleTagging, type LifecycleClass } from './lifecycle';

/**
 * S3-compatible object storage.
 *
 * Evidence lifecycle: uploads land in the QUARANTINE bucket, are malware
 * scanned, and only clean objects are promoted to the EVIDENCE bucket. Every
 * object key is namespaced by organisation (`orgId/...`) so a presigned URL can
 * never address another tenant's data. Objects are ALWAYS private — we never
 * set a public ACL. In production, server-side encryption uses KMS
 * (`aws:kms`); locally against MinIO we fall back to `AES256`.
 */

const globalForS3 = globalThis as unknown as { __blakpathS3?: S3Client };

export const s3: S3Client =
  globalForS3.__blakpathS3 ??
  new S3Client({
    region: env.S3_REGION,
    // MinIO / self-hosted requires path-style addressing.
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });

if (env.NODE_ENV !== 'production') {
  globalForS3.__blakpathS3 = s3;
}

export const QUARANTINE_BUCKET = env.S3_BUCKET_QUARANTINE;
export const EVIDENCE_BUCKET = env.S3_BUCKET_EVIDENCE;

/** Short lifetime for presigned URLs — minimise the window of misuse. */
const PRESIGN_TTL_SECONDS = 300;

/**
 * SSE expectation: KMS in production, AES256 for AWS-backed non-production
 * environments. Local S3-compatible endpoints may not have a KMS configured,
 * so development relies on the local volume controls instead.
 */
function encryptionOptions(): {
  ServerSideEncryption: ServerSideEncryption;
  SSEKMSKeyId?: string;
} {
  if (env.NODE_ENV !== 'production') return { ServerSideEncryption: 'AES256' };
  if (!env.S3_KMS_KEY_ID) {
    throw new Error('S3_KMS_KEY_ID is required for production object writes');
  }
  return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: env.S3_KMS_KEY_ID };
}

const KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Build a tenant-namespaced object key. The first segment is always the
 * organisation id; every segment is validated so a crafted id cannot traverse
 * (`../`) into another tenant's namespace.
 *
 * @throws on empty or unsafe segments.
 */
export function objectKey(organisationId: string, ...parts: string[]): string {
  if (!organisationId) throw new Error('objectKey requires an organisationId');
  const segments = [organisationId, ...parts];
  for (const seg of segments) {
    if (!seg || !KEY_SEGMENT.test(seg)) {
      throw new Error(`Unsafe object key segment: ${JSON.stringify(seg)}`);
    }
  }
  return segments.join('/');
}

/** Assert a key belongs to the given tenant before signing/moving it. */
function assertOwnedKey(organisationId: string, key: string): void {
  if (!key.startsWith(`${organisationId}/`)) {
    throw new Error('Object key is not namespaced to the active organisation');
  }
}

export interface PresignedUpload {
  url: string;
  headers: Readonly<Record<string, string>>;
  bucket: string;
  key: string;
  expiresIn: number;
}

/**
 * Presign a short-lived PUT into the QUARANTINE bucket under the tenant's
 * namespace. Content type and length are pinned so the client cannot upload a
 * different object than declared.
 */
export async function presignUpload(params: {
  organisationId: string;
  key: string;
  contentType: string;
  contentLength: number;
}): Promise<PresignedUpload> {
  assertOwnedKey(params.organisationId, params.key);
  const encryption = env.S3_ENDPOINT ? undefined : encryptionOptions();
  const command = new PutObjectCommand({
    Bucket: QUARANTINE_BUCKET,
    Key: params.key,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
    ...encryption,
  });
  const url = await getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL_SECONDS });
  return {
    url,
    headers: encryption
      ? {
          'x-amz-server-side-encryption': encryption.ServerSideEncryption,
          ...(encryption.SSEKMSKeyId
            ? { 'x-amz-server-side-encryption-aws-kms-key-id': encryption.SSEKMSKeyId }
            : {}),
        }
      : {},
    bucket: QUARANTINE_BUCKET,
    key: params.key,
    expiresIn: PRESIGN_TTL_SECONDS,
  };
}

/**
 * Presign a short-lived GET from the EVIDENCE bucket. The response is forced to
 * download (`attachment`) so evidence is never rendered inline in a browser
 * tab, and the filename is sanitised to avoid header injection.
 */
export async function presignDownload(params: {
  organisationId: string;
  key: string;
  fileName: string;
}): Promise<{ url: string; expiresIn: number }> {
  assertOwnedKey(params.organisationId, params.key);
  const safeName =
    params.fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'evidence';
  const command = new GetObjectCommand({
    Bucket: EVIDENCE_BUCKET,
    Key: params.key,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
  });
  const url = await getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL_SECONDS });
  return { url, expiresIn: PRESIGN_TTL_SECONDS };
}

/**
 * Promote a scanned-clean object from QUARANTINE to EVIDENCE. Copies within the
 * same tenant namespace, re-applies SSE, then deletes the quarantine copy.
 */
export async function moveQuarantineToEvidence(params: {
  organisationId: string;
  key: string;
}): Promise<{ bucket: string; key: string }> {
  assertOwnedKey(params.organisationId, params.key);
  const encryption = env.S3_ENDPOINT ? undefined : encryptionOptions();
  await s3.send(
    new CopyObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: params.key,
      CopySource: `/${QUARANTINE_BUCKET}/${params.key}`,
      ...encryption,
      MetadataDirective: 'COPY',
    }),
  );
  await s3.send(new DeleteObjectCommand({ Bucket: QUARANTINE_BUCKET, Key: params.key }));
  logger.debug(
    { organisationId: params.organisationId, key: params.key },
    'Promoted object from quarantine to evidence',
  );
  return { bucket: EVIDENCE_BUCKET, key: params.key };
}

/**
 * Read a whole object into memory. Used by the malware scanner to stream bytes
 * to ClamAV. Callers must bound object size upstream (see the evidence size
 * limit) so this never loads an unbounded payload.
 */
export async function getObjectBytes(params: {
  bucket: string;
  key: string;
}): Promise<Buffer> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: params.bucket, Key: params.key }),
  );
  const body = result.Body;
  if (!body) throw new Error('Object has no body');
  // @aws-sdk streams expose transformToByteArray in Node and the browser.
  const bytes = await (
    body as { transformToByteArray: () => Promise<Uint8Array> }
  ).transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Upload bytes directly to a bucket (e.g. a server-rendered certificate PDF).
 * Server-side encryption is applied to match the bucket policy. The key must be
 * tenant-namespaced by the caller.
 */
export async function putObjectBytes(params: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ...(env.S3_ENDPOINT ? {} : encryptionOptions()),
    }),
  );
}

/** S3's minimum multipart part size; also bounds streamed-upload memory. */
const STREAM_PART_BYTES = 5 * 1024 * 1024;

/**
 * Stream a body of unknown length to a bucket (e.g. a generated export). Small
 * bodies go up as one PUT; larger ones as a multipart upload holding at most a
 * couple of parts in memory. A failed multipart upload is aborted so no
 * orphaned parts remain. A `lifecycle` class tags the object so the bucket's
 * lifecycle rules expire it (see `./lifecycle`). The key must be
 * tenant-namespaced by the caller.
 */
export async function uploadObjectStream(params: {
  bucket: string;
  key: string;
  body: Readable;
  contentType: string;
  lifecycle?: LifecycleClass;
}): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      // Tag at creation (PUT / CreateMultipartUpload) so the object is never
      // briefly untagged and outside its lifecycle rule.
      ...(params.lifecycle ? { Tagging: lifecycleTagging(params.lifecycle) } : {}),
      ...(env.S3_ENDPOINT ? {} : encryptionOptions()),
    },
    partSize: STREAM_PART_BYTES,
    queueSize: 2,
    leavePartsOnError: false,
  });
  await upload.done();
}

/**
 * Permanently delete EVERY version (and delete marker) of one object key. In a
 * versioned bucket a plain delete only hides the object behind a marker, so
 * short-lived data such as exports would otherwise linger as noncurrent
 * versions. Returns the number of versions removed.
 */
export async function purgeObjectVersions(params: {
  bucket: string;
  key: string;
}): Promise<number> {
  let removed = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (;;) {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: params.bucket,
        Prefix: params.key,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].filter(
      // Prefix also matches longer keys (`a.csv` vs `a.csv.bak`); exact only.
      (v) => v.Key === params.key && v.VersionId,
    );
    for (const v of versions) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: params.bucket,
          Key: params.key,
          VersionId: v.VersionId,
        }),
      );
      removed += 1;
    }
    if (!page.IsTruncated) return removed;
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
}

/** Delete a single object (e.g. removing an infected or rejected upload). */
export async function deleteObject(params: {
  bucket: string;
  key: string;
}): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: params.bucket, Key: params.key }));
}

/** Reachability probe for readiness checks — verifies the evidence bucket. */
export async function checkS3(timeoutMs = 2_000): Promise<boolean> {
  try {
    await Promise.race([
      s3.send(new HeadBucketCommand({ Bucket: EVIDENCE_BUCKET })),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('s3 head timeout')), timeoutMs),
      ),
    ]);
    return true;
  } catch (err) {
    logger.warn({ err }, 'S3 reachability check failed');
    return false;
  }
}
