/**
 * The migrate Job and the web Deployment must use one image digest.
 * Tokens in `infra/k8s/base/jobs/migrate.yaml` are replaced per release; the
 * Job stays out of every kustomization because a Job name is immutable.
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

/** Image names in the public base. Overlays map them to the registry. */
const APP_IMAGE_NAME = 'blakpath/app';
const WORKER_IMAGE_NAME = 'blakpath/worker';

/** Deploy environments and their namespaces (infra/k8s/overlays/<environment>). */
export const DEPLOY_NAMESPACES = {
  production: 'blakpath',
  staging: 'blakpath-staging',
} as const;

export type DeployEnvironment = keyof typeof DEPLOY_NAMESPACES;

export function assertDeployEnvironment(
  value: string,
): asserts value is DeployEnvironment {
  if (!Object.hasOwn(DEPLOY_NAMESPACES, value)) {
    throw new Error(
      `environment must be one of ${Object.keys(DEPLOY_NAMESPACES).join(', ')}`,
    );
  }
}

/**
 * Replace the overlay's `__ECR_REGISTRY__` / `__IMAGE_TAG__` image entries
 * with the release repositories and digests.
 */
export function pinKustomizationImages(source: string, release: ReleaseImages): string {
  assertDigestImage(release.appImage, APP_IMAGE_REPOSITORY);
  assertDigestImage(release.workerImage, WORKER_IMAGE_REPOSITORY);
  const pinned = pinOne(
    pinOne(source, APP_IMAGE_NAME, APP_IMAGE_REPOSITORY, release.appImage),
    WORKER_IMAGE_NAME,
    WORKER_IMAGE_REPOSITORY,
    release.workerImage,
  );
  if (/\bnewTag\s*:/.test(pinned)) {
    throw new Error('kustomization still has a floating image tag');
  }
  return pinned;
}

function pinOne(source: string, name: string, repository: string, image: string): string {
  const digest = image.slice(repository.length + 1);
  const pattern = new RegExp(
    `(- name: ${escapeRegExp(name)}\\r?\\n)([ \\t]+)newName:\\s*\\S+(\\r?\\n)[ \\t]+newTag:\\s*\\S+`,
  );
  if (!pattern.test(source)) {
    throw new Error(`kustomization is missing image ${name}`);
  }
  return source.replace(
    pattern,
    (_match, head: string, indent: string, eol: string) =>
      `${head}${indent}newName: ${repository}${eol}${indent}digest: ${digest}`,
  );
}

/** Private CD values that fill overlay tokens. Names match the deploy env vars. */
export const DEPLOY_VALUE_NAMES = [
  'AWS_ACCOUNT_ID',
  'S3_BUCKET_EVIDENCE',
  'S3_BUCKET_QUARANTINE',
  'S3_BUCKET_AUDIT_ANCHORS',
  'S3_KMS_KEY_ID',
] as const;

const DEPLOY_TOKEN = /__([A-Z0-9_]+?)__/g;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9:/._-]*$/;

/**
 * Fill `__AWS_ACCOUNT_ID__` and `__<ENVIRONMENT>_<NAME>__` overlay tokens from
 * private CD values. Refuses a missing or unsafe value, another environment's
 * token, and any token left over.
 */
export function substituteDeployTokens(
  source: string,
  environment: DeployEnvironment,
  values: Readonly<Record<string, string | undefined>>,
): string {
  const prefix = `${environment.toUpperCase()}_`;
  const names: readonly string[] = DEPLOY_VALUE_NAMES;
  const filled = source.replace(DEPLOY_TOKEN, (token, inner: string) => {
    const name =
      inner === 'AWS_ACCOUNT_ID'
        ? inner
        : inner.startsWith(prefix)
          ? inner.slice(prefix.length)
          : '';
    if (!names.includes(name)) return token;
    const value = values[name];
    if (!value) throw new Error(`${name} is required for ${token}`);
    if (!SAFE_VALUE.test(value)) {
      throw new Error(`${name} has characters a manifest value cannot hold`);
    }
    if (name === 'AWS_ACCOUNT_ID' && !/^\d{12}$/.test(value)) {
      throw new Error('AWS_ACCOUNT_ID must be a 12-digit account id');
    }
    return value;
  });
  const left = filled.match(/__[A-Z0-9_]+__/);
  if (left) throw new Error(`unresolved deploy token ${left[0]}`);
  return filled;
}

function imageFromJob(rendered: string): string {
  const match = rendered.match(/^\s*image:\s*(\S+)\s*$/m);
  if (!match?.[1]) throw new Error('rendered migrate job has no image');
  return match[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
