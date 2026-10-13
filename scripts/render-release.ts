/* eslint-disable no-restricted-properties -- release rendering reads the operator's deploy env. */
import fs from 'node:fs';
import path from 'node:path';
import {
  pinKustomizationImages,
  renderMigrateJob,
  type ReleaseImages,
} from '@/db/release-job';

const workdir = process.argv[2];
if (!workdir) {
  console.error('usage: tsx scripts/render-release.ts <kustomize-workdir>');
  process.exit(1);
}

const release: ReleaseImages = {
  appImage: required('IMAGE'),
  workerImage: required('WORKER_IMAGE'),
  releaseId: required('RELEASE_ID'),
};

const root = path.resolve(workdir);
const template = fs.readFileSync(path.join(root, 'jobs', 'migrate.yaml'), 'utf8');
const kustomizationPath = path.join(root, 'kustomization.yaml');
const kustomization = fs.readFileSync(kustomizationPath, 'utf8');

fs.writeFileSync(
  path.join(root, 'migrate-job.yaml'),
  renderMigrateJob(template, release),
);
fs.writeFileSync(kustomizationPath, pinKustomizationImages(kustomization, release));

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}
