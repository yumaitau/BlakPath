/** Digest-pinned image references. A tag is not a deploy pointer. */

const REPOSITORY = /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DIGEST_REF = new RegExp(
  `^${REPOSITORY.source.slice(1, -1)}@${DIGEST.source.slice(1, -1)}$`,
);
const ROLLBACK_REF = new RegExp(
  `^(?:MISSING|${REPOSITORY.source.slice(1, -1)}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@${DIGEST.source.slice(1, -1)}))$`,
);

export function digestImageRef(repository: string, digest: string): string {
  if (!REPOSITORY.test(repository)) {
    throw new Error('image repository must be a registry path without a tag or digest');
  }
  if (!DIGEST.test(digest)) {
    throw new Error('image digest must be sha256 and 64 hex characters');
  }
  return `${repository}@${digest}`;
}

export function assertDigestImageRef(image: string): void {
  if (!DIGEST_REF.test(image)) {
    throw new Error(
      'deployment image must be digest-pinned as repository@sha256:<64 hex>',
    );
  }
}

/** Previous workloads may still be on an immutable tag. New deploys may not. */
export function assertRollbackImage(image: string): void {
  if (!ROLLBACK_REF.test(image) || image === 'MISSING') {
    throw new Error('refusing rollback image; expected a tag or a digest pin');
  }
}

export function assertRestorableImages(web: string, worker: string): void {
  if (
    web === 'MISSING' ||
    worker === 'MISSING' ||
    web.length === 0 ||
    worker.length === 0
  ) {
    throw new Error('no previous workload image; refusing to delete the deployment');
  }
  assertRollbackImage(web);
  assertRollbackImage(worker);
}

export interface ProductionReleaseRecord {
  tag: string;
  commit: string;
  webImage: string;
  workerImage: string;
  releaseGateImage: string;
}

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[a-f0-9]{40}$/;

/** Every production deploy must name the git tag and both image digests. */
export function assertProductionReleaseRecord(record: ProductionReleaseRecord): void {
  if (!RELEASE_TAG.test(record.tag)) {
    throw new Error('release tag must be semver vMAJOR.MINOR.PATCH');
  }
  if (!COMMIT.test(record.commit)) {
    throw new Error('release commit must be the 40-character git sha that was built');
  }
  assertDigestImageRef(record.webImage);
  assertDigestImageRef(record.workerImage);
  if (record.releaseGateImage !== record.workerImage) {
    throw new Error(
      'release gate must run the worker image digest that is being deployed',
    );
  }
}
