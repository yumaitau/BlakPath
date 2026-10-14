import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  type ObjectLockMode,
} from '@aws-sdk/client-s3';
import { env, isProduction } from '@/lib/env';
import { s3, s3ServerSideEncryption } from '@/lib/storage/s3';
import type { AuditAnchorStore } from './anchor';

/**
 * Anchor objects live in their own bucket. Production puts use compliance
 * retention so a later writer cannot replace or delete the day's head.
 * `If-None-Match: *` makes the create conditional: the first object wins.
 */

function retainUntil(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function bodyText(body: unknown): Promise<string> {
  if (!body || typeof body !== 'object' || !('transformToString' in body)) {
    throw new Error('Audit anchor object has no body');
  }
  return (body as { transformToString: () => Promise<string> }).transformToString();
}

export function createS3AuditAnchorStore(): AuditAnchorStore {
  const bucket = env.S3_BUCKET_AUDIT_ANCHORS;
  return {
    async get(key) {
      try {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return await bodyText(result.Body);
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        if (
          typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error.name === 'NoSuchKey' || error.name === 'NotFound')
        ) {
          return null;
        }
        throw error;
      }
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async put(key, body) {
      if (isProduction() && !env.AUDIT_ANCHOR_OBJECT_LOCK) {
        throw new Error('AUDIT_ANCHOR_OBJECT_LOCK must be enabled in production');
      }
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          IfNoneMatch: '*',
          ...(s3ServerSideEncryption() ?? {}),
          ...(env.AUDIT_ANCHOR_OBJECT_LOCK
            ? {
                ObjectLockMode: 'COMPLIANCE' satisfies ObjectLockMode,
                ObjectLockRetainUntilDate: retainUntil(env.AUDIT_ANCHOR_RETENTION_DAYS),
              }
            : {}),
        }),
      );
    },
  };
}
