import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { getOrganisationKey } from '@/domains/organisation-keys';
import { TenantKeyUnavailableError } from '@/lib/encryption/errors';
import { parseKeyArn } from '@/lib/encryption/key-provider';
import { env } from '@/lib/env';
import { logger } from '@/lib/observability/logger';

/**
 * S3-compatible object storage.
 *
 * Evidence lifecycle: uploads land in the QUARANTINE bucket, are malware
 * scanned, and only clean objects are promoted to the EVIDENCE bucket. Every
 * object key is namespaced by organisation (`orgId/...`) so a presigned URL can
 * never address another tenant's data. Objects are ALWAYS private — we never
 * set a public ACL. Tenant objects use SSE-KMS with that tenant's CMK and
 * bucket keys disabled. A local S3 endpoint skips the SSE headers because
 * MinIO cannot wrap the tenant CMK, but the tenant key must still be active.
 * `S3_KMS_KEY_ID` remains the bucket default only.
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

/** Local S3 (MinIO) cannot apply a tenant CMK. Real AWS always does. */
function tenantSseEnabled(): boolean {
  return !env.S3_ENDPOINT;
}

/**
 * SSE-KMS with the tenant CMK. Bucket keys stay off so each object is wrapped
 * by that key and HeadObject reports it.
 */
export function tenantObjectSse(kmsKeyArn: string): {
  ServerSideEncryption: 'aws:kms';
  SSEKMSKeyId: string;
  BucketKeyEnabled: false;
} {
  parseKeyArn(kmsKeyArn);
  return {
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: kmsKeyArn,
    BucketKeyEnabled: false,
  };
}

export function presignSseHeaders(sse: {
  ServerSideEncryption: string;
  SSEKMSKeyId: string;
}): Record<string, string> {
  return {
    'x-amz-server-side-encryption': sse.ServerSideEncryption,
    'x-amz-server-side-encryption-aws-kms-key-id': sse.SSEKMSKeyId,
    'x-amz-server-side-encryption-bucket-key-enabled': 'false',
  };
}

/** Key id reported by HeadObject when the object used SSE-KMS. */
export function tenantKeyArnFromHead(head: {
  ServerSideEncryption?: string | undefined;
  SSEKMSKeyId?: string | undefined;
}): string | null {
  if (head.ServerSideEncryption !== 'aws:kms') return null;
  return head.SSEKMSKeyId ?? null;
}

async function requireActiveTenantKey(organisationId: string): Promise<string> {
  const row = await getOrganisationKey(organisationId);
  if (!row) throw new TenantKeyUnavailableError(organisationId, 503);
  if (row.status === 'disabled' || row.status === 'pending_deletion') {
    throw new TenantKeyUnavailableError(organisationId, 423);
  }
  if (row.status !== 'active') throw new TenantKeyUnavailableError(organisationId, 503);
  return row.kmsKeyArn;
}

/** Platform CMK for objects that are not bound to one tenant, such as audit anchors. */
export function s3ServerSideEncryption():
  | {
      ServerSideEncryption: ServerSideEncryption;
      SSEKMSKeyId?: string;
    }
  | undefined {
  if (env.S3_ENDPOINT) return undefined;
  return legacyEncryption();
}

/** Shared-key fallback for non-tenant callers (restore verification). */
function legacyEncryption(): {
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

/**
 * S3 reports a missing object as `NotFound` (HeadObject) or `NoSuchKey`
 * (GetObject). MinIO uses the same names. Anything else is a real storage fault.
 */
export function isMissingObject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? err.name : undefined;
  if (name === 'NotFound' || name === 'NoSuchKey') return true;
  const meta = '$metadata' in err ? err.$metadata : undefined;
  return (
    typeof meta === 'object' &&
    meta !== null &&
    'httpStatusCode' in meta &&
    meta.httpStatusCode === 404
  );
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
 * Headers bound into the upload signature. The presigner treats `content-type`
 * as unsignable by default, so it is opted back in explicitly; `content-length`
 * is listed for clarity (the SDK already signs it). S3 then refuses a PUT whose
 * type or length differs from what was declared.
 */
const SIGNED_UPLOAD_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
]);

/**
 * Presign a short-lived PUT into the QUARANTINE bucket under the tenant's
 * namespace. Content type and length are signed so the client cannot upload a
 * different object than declared. The returned `headers` must be sent verbatim
 * with the PUT.
 */
export async function presignUpload(params: {
  organisationId: string;
  key: string;
  contentType: string;
  contentLength: number;
}): Promise<PresignedUpload> {
  assertOwnedKey(params.organisationId, params.key);
  const kmsKeyArn = await requireActiveTenantKey(params.organisationId);
  const encryption = tenantSseEnabled() ? tenantObjectSse(kmsKeyArn) : undefined;
  const command = new PutObjectCommand({
    Bucket: QUARANTINE_BUCKET,
    Key: params.key,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
    ...encryption,
  });
  const url = await getSignedUrl(s3, command, {
    expiresIn: PRESIGN_TTL_SECONDS,
    signableHeaders: new Set(SIGNED_UPLOAD_HEADERS),
  });
  return {
    url,
    headers: {
      'Content-Type': params.contentType,
      ...(encryption ? presignSseHeaders(encryption) : {}),
    },
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
  await requireActiveTenantKey(params.organisationId);
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
 *
 * The stored Content-Type is replaced with the type verified from magic bytes,
 * never the client-declared one. `ifMatch` pins the copy to the exact object
 * version that was verified and scanned; a re-uploaded object fails the copy.
 */
export async function moveQuarantineToEvidence(params: {
  organisationId: string;
  key: string;
  contentType: string;
  ifMatch: string;
}): Promise<{ bucket: string; key: string }> {
  assertOwnedKey(params.organisationId, params.key);
  const kmsKeyArn = await requireActiveTenantKey(params.organisationId);
  const encryption = tenantSseEnabled() ? tenantObjectSse(kmsKeyArn) : undefined;
  await s3.send(
    new CopyObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: params.key,
      CopySource: `/${QUARANTINE_BUCKET}/${params.key}`,
      CopySourceIfMatch: params.ifMatch,
      ContentType: params.contentType,
      ...encryption,
      MetadataDirective: 'REPLACE',
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
 * Size, stored type and ETag of an object, without reading its body. With
 * `organisationId` the tenant key must be active first (fail closed).
 */
export async function headObject(params: {
  bucket: string;
  key: string;
  organisationId?: string;
}): Promise<{
  contentLength: number | undefined;
  contentType: string | undefined;
  etag: string | undefined;
}> {
  if (params.organisationId) await requireActiveTenantKey(params.organisationId);
  const result = await s3.send(
    new HeadObjectCommand({ Bucket: params.bucket, Key: params.key }),
  );
  return {
    contentLength: result.ContentLength,
    contentType: result.ContentType,
    etag: result.ETag,
  };
}

/**
 * Open an object's body as a Node stream, so large objects are never held in
 * memory. S3 decrypts under the tenant CMK; with `organisationId` the tenant
 * key must be active first (fail closed). `ifMatch` pins the read to a
 * specific ETag (S3 answers 412 if the object has since been replaced). The
 * caller must consume or destroy the stream.
 */
export async function getObjectStream(params: {
  bucket: string;
  key: string;
  ifMatch?: string;
  organisationId?: string;
}): Promise<Readable> {
  if (params.organisationId) await requireActiveTenantKey(params.organisationId);
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      ...(params.ifMatch ? { IfMatch: params.ifMatch } : {}),
    }),
  );
  if (!result.Body) throw new Error('Object has no body');
  // In Node the SDK body is an http IncomingMessage (a Readable).
  return result.Body as Readable;
}

/**
 * Read a whole object into memory. Only for small objects (e.g. restore-drill
 * verification); evidence scanning streams via getObjectStream instead. S3
 * decrypts under the tenant CMK into this process only. Callers must bound
 * object size upstream and zero the buffer when they are finished.
 * `organisationId` is optional for restore checks that are not serving a
 * tenant.
 */
export async function getObjectBytes(params: {
  bucket: string;
  key: string;
  organisationId?: string;
}): Promise<Buffer> {
  if (params.organisationId) await requireActiveTenantKey(params.organisationId);
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
  organisationId?: string;
}): Promise<void> {
  const encryption = params.organisationId
    ? tenantSseEnabled()
      ? tenantObjectSse(await requireActiveTenantKey(params.organisationId))
      : undefined
    : env.S3_ENDPOINT
      ? undefined
      : legacyEncryption();
  await s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ...encryption,
    }),
  );
}

/**
 * Head an object and report the SSE-KMS key. The caller compares it with the
 * tenant key ARN. A disabled key fails closed before the head.
 */
export async function headTenantObject(params: {
  bucket: string;
  key: string;
  organisationId: string;
}): Promise<{
  sse: string | null;
  kmsKeyId: string | null;
  bucketKeyEnabled: boolean | null;
}> {
  await requireActiveTenantKey(params.organisationId);
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: params.bucket, Key: params.key }),
  );
  return {
    sse: head.ServerSideEncryption ?? null,
    kmsKeyId: tenantKeyArnFromHead({
      ServerSideEncryption: head.ServerSideEncryption,
      SSEKMSKeyId: head.SSEKMSKeyId,
    }),
    bucketKeyEnabled: head.BucketKeyEnabled ?? null,
  };
}

/** Delete a single object (e.g. removing an infected or rejected upload). */
export async function deleteObject(params: {
  bucket: string;
  key: string;
}): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: params.bucket, Key: params.key }));
}

const VERSION_DELETE_LIMIT = 1000;
const VERSION_DELETE_PASSES = 10;

interface ListedVersion {
  Key?: string;
  VersionId?: string;
}

/**
 * Remove every stored version of one key, including delete markers.
 *
 * `DeleteObject` without a version id only adds a delete marker on a versioned
 * bucket, so the bytes remain. This lists versions and deletes each version id.
 * It throws if any version remains or the API returns a per-key error, so the
 * caller can audit the failure and retry. A missing key is success.
 */
export async function deleteAllObjectVersions(params: {
  bucket: string;
  key: string;
  client?: S3Client;
}): Promise<void> {
  if (!params.key) throw new Error('deleteAllObjectVersions requires a key');
  const api = params.client ?? s3;

  for (let pass = 0; pass < VERSION_DELETE_PASSES; pass += 1) {
    const versionIds = await listVersionIds(api, params.bucket, params.key);
    if (versionIds.length === 0) return;
    for (let offset = 0; offset < versionIds.length; offset += VERSION_DELETE_LIMIT) {
      const chunk = versionIds.slice(offset, offset + VERSION_DELETE_LIMIT);
      const result = (await api.send(
        new DeleteObjectsCommand({
          Bucket: params.bucket,
          Delete: {
            Objects: chunk.map((versionId) => ({
              Key: params.key,
              VersionId: versionId,
            })),
            Quiet: false,
          },
        }),
      )) as { Errors?: Array<{ Key?: string; VersionId?: string; Message?: string }> };
      const errors = result.Errors ?? [];
      if (errors.length > 0) {
        const sample = errors[0]?.Message ?? 'delete failed';
        throw new Error(
          `Failed to delete ${errors.length} object version(s) for ${params.key}: ${sample}`,
        );
      }
    }
  }

  const remaining = await listVersionIds(api, params.bucket, params.key);
  if (remaining.length > 0) {
    throw new Error(`Object versions remain for ${params.key}`);
  }
}

async function listVersionIds(
  api: S3Client,
  bucket: string,
  key: string,
): Promise<string[]> {
  const versionIds: string[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = (await api.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    )) as {
      Versions?: ListedVersion[];
      DeleteMarkers?: ListedVersion[];
      IsTruncated?: boolean;
      NextKeyMarker?: string;
      NextVersionIdMarker?: string;
    };
    for (const entry of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (entry.Key === key && entry.VersionId) versionIds.push(entry.VersionId);
    }
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
    if (!page.IsTruncated) break;
  } while (keyMarker);
  return versionIds;
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
