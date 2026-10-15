/**
 * Object-lifecycle contract shared by the application and the S3 lifecycle
 * rules in `infra/aws/s3-lifecycle/`.
 *
 * S3 lifecycle filters match a key PREFIX or an object TAG, never a wildcard.
 * Every key starts with the organisation id (`orgId/...`), so short-lived
 * objects cannot be selected by prefix; instead the writer tags them and the
 * bucket rule filters on the tag. `tests/unit/storage-lifecycle.test.ts` pins
 * these values to the IaC so the two cannot drift apart.
 */

/** Object tag key the lifecycle rules filter on. */
export const LIFECYCLE_TAG_KEY = 'blakpath-lifecycle';

/** Lifecycle classes an object can be tagged with. */
export type LifecycleClass = 'export';

/** Days a generated export may be downloaded before it is removed. */
export const EXPORT_TTL_DAYS = 7;

/** Days an object may sit in the quarantine bucket before it is abandoned. */
export const QUARANTINE_TTL_DAYS = 2;

/** `x-amz-tagging` header value (URL query encoded) for a lifecycle class. */
export function lifecycleTagging(lifecycle: LifecycleClass): string {
  return new URLSearchParams({ [LIFECYCLE_TAG_KEY]: lifecycle }).toString();
}
