/**
 * The migrate Job and the web Deployment must use one image digest.
 * Tokens in `infra/k8s/jobs/migrate.yaml` are replaced per release; the Job
 * stays out of kustomization.yaml because a Job name is immutable.
 */

export const APP_IMAGE_REPOSITORY =
  '959038055523.dkr.ecr.ap-southeast-2.amazonaws.com/blakpath/app';
export const WORKER_IMAGE_REPOSITORY =
  '959038055523.dkr.ecr.ap-southeast-2.amazonaws.com/blakpath/worker';

const DIGEST_REF =
  /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[a-f0-9]{64}$/;
const RELEASE_ID = /^[0-9a-f]{7,40}$/;

export interface ReleaseImages {
  appImage: string;
  workerImage: string;
  releaseId: string;
}

export function assertDigestImage(image: string, repository: string): void {
  if (!DIGEST_REF.test(image) || !image.startsWith(`${repository}@sha256:`)) {
    throw new Error(`${repository} must be pinned to a sha256 digest, not a tag`);
  }
}

export function assertReleaseId(releaseId: string): void {
  if (!RELEASE_ID.test(releaseId)) {
    throw new Error('release id must be a 7 to 40 character git sha');
  }
}

export function assertSameReleaseImage(migrateImage: string, appImage: string): void {
  if (migrateImage !== appImage) {
    throw new Error('migrate job image digest must equal the app release digest');
  }
}

export function renderMigrateJob(template: string, release: ReleaseImages): string {
  assertDigestImage(release.appImage, APP_IMAGE_REPOSITORY);
  assertDigestImage(release.workerImage, WORKER_IMAGE_REPOSITORY);
  assertReleaseId(release.releaseId);
  if (!template.includes('__IMAGE__') || !template.includes('__RELEASE_ID__')) {
    throw new Error('migrate job template is missing __IMAGE__ or __RELEASE_ID__');
  }
  const rendered = template
    .replaceAll('__IMAGE__', release.appImage)
    .replaceAll('__RELEASE_ID__', release.releaseId);
  if (rendered.includes('__IMAGE__') || rendered.includes('__RELEASE_ID__')) {
    throw new Error('migrate job template was not fully rendered');
  }
  assertSameReleaseImage(imageFromJob(rendered), release.appImage);
  return rendered;
}

/** Replace floating tags in the kustomization image list with release digests. */
export function pinKustomizationImages(source: string, release: ReleaseImages): string {
  assertDigestImage(release.appImage, APP_IMAGE_REPOSITORY);
  assertDigestImage(release.workerImage, WORKER_IMAGE_REPOSITORY);
  const pinned = pinOne(
    pinOne(source, APP_IMAGE_REPOSITORY, release.appImage),
    WORKER_IMAGE_REPOSITORY,
    release.workerImage,
  );
  if (/\bnewTag\s*:/.test(pinned)) {
    throw new Error('kustomization still has a floating image tag');
  }
  return pinned;
}

function pinOne(source: string, repository: string, image: string): string {
  const digest = image.slice(repository.length + 1);
  const pattern = new RegExp(
    `(- name: ${escapeRegExp(repository)}\\r?\\n\\s+)newTag:\\s*\\S+`,
  );
  if (!pattern.test(source)) {
    throw new Error(`kustomization is missing image ${repository}`);
  }
  return source.replace(pattern, `$1digest: ${digest}`);
}

function imageFromJob(rendered: string): string {
  const match = rendered.match(/^\s*image:\s*(\S+)\s*$/m);
  if (!match?.[1]) throw new Error('rendered migrate job has no image');
  return match[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
