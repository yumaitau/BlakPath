/* eslint-disable no-restricted-properties -- release rendering reads the operator's deploy env. */
import fs from 'node:fs';
import path from 'node:path';
import {
  assertDeployEnvironment,
  DEPLOY_NAMESPACES,
  pinKustomizationImages,
  renderMigrateJob,
  substituteDeployTokens,
  type DeployEnvironment,
  type ReleaseImages,
} from '@/db/release-job';

const workdir = process.argv[2];
const environmentArg = process.argv[3] ?? 'production';
if (!workdir) {
  console.error('usage: tsx scripts/render-release.ts <kustomize-workdir> [environment]');
  process.exit(1);
}
assertDeployEnvironment(environmentArg);
const environment: DeployEnvironment = environmentArg;

const release: ReleaseImages = {
  appImage: required('IMAGE'),
  workerImage: required('WORKER_IMAGE'),
  releaseId: required('RELEASE_ID'),
};

const root = path.resolve(workdir);
const overlay = path.join(root, 'overlays', environment);

// The per-release migrate Job, namespaced for the environment by kustomize.
const template = fs.readFileSync(path.join(root, 'base', 'jobs', 'migrate.yaml'), 'utf8');
const migrateDir = path.join(root, 'migrate');
fs.mkdirSync(migrateDir, { recursive: true });
fs.writeFileSync(
  path.join(migrateDir, 'migrate-job.yaml'),
  renderMigrateJob(template, release),
);
fs.writeFileSync(
  path.join(migrateDir, 'kustomization.yaml'),
  [
    'apiVersion: kustomize.config.k8s.io/v1beta1',
    'kind: Kustomization',
    `namespace: ${DEPLOY_NAMESPACES[environment]}`,
    'resources:',
    '  - migrate-job.yaml',
    '',
  ].join('\n'),
);

// Workloads and the release gate run the same candidate digests. Overlay
// tokens (account id, buckets, bucket CMK) come from private CD config.
pinAndFill(path.join(overlay, 'kustomization.yaml'));
pinAndFill(path.join(overlay, 'release-check', 'kustomization.yaml'));
for (const entry of fs.readdirSync(overlay, { withFileTypes: true })) {
  if (entry.isFile() && entry.name !== 'kustomization.yaml') {
    fill(path.join(overlay, entry.name));
  }
}

function pinAndFill(file: string): void {
  const pinned = pinKustomizationImages(fs.readFileSync(file, 'utf8'), release);
  fs.writeFileSync(file, substituteDeployTokens(pinned, environment, process.env));
}

function fill(file: string): void {
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, substituteDeployTokens(source, environment, process.env));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}
