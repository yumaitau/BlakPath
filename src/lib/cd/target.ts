/** Fail closed when a deploy would touch the wrong namespace or secret path. */

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1)$/i;
const KUBE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export type DeployEnvironment = 'staging' | 'production';

export type DeployPhase = 'release-gate' | 'migrate' | 'rollout' | 'smoke';

export function assertEnvironmentName(value: string): DeployEnvironment {
  if (value === 'staging' || value === 'production') return value;
  throw new Error('environment must be staging or production');
}

export function assertKubeName(value: string, label: string): void {
  if (!KUBE_NAME.test(value) || value.length > 63) {
    throw new Error(`${label} is not a Kubernetes name`);
  }
}

export function assertPublicAppUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('app URL is not a URL');
  }
  if (url.protocol !== 'https:' || LOCAL_HOST.test(url.hostname)) {
    throw new Error('app URL must be https and not a local host');
  }
  if (url.username || url.password) {
    throw new Error('app URL must not carry credentials');
  }
  return url;
}

export function assertSameAppUrl(expected: string, actual: string): void {
  const wanted = assertPublicAppUrl(expected);
  const found = assertPublicAppUrl(actual);
  if (wanted.origin !== found.origin) {
    throw new Error(
      `cluster APP_URL ${found.origin} does not match the ${wanted.origin} deploy target`,
    );
  }
}

export function runtimeSecretPath(environment: DeployEnvironment): string {
  return environment === 'production'
    ? '/blakpath/production/runtime'
    : '/blakpath/staging/runtime';
}

export function assertRuntimeSecretPath(
  environment: DeployEnvironment,
  actual: string,
): void {
  const expected = runtimeSecretPath(environment);
  if (actual !== expected) {
    throw new Error(`runtime secret path must be ${expected}`);
  }
}

/**
 * The release gate and migrate stop the line with the previous workloads still serving.
 * Rollout and smoke failures roll the workloads back. Migrations are not reversed.
 */
export function failureAction(phase: DeployPhase): 'stop' | 'rollback' {
  if (phase === 'release-gate' || phase === 'migrate') return 'stop';
  return 'rollback';
}
