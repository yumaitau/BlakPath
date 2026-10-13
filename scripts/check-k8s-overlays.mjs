#!/usr/bin/env node
/**
 * Checks the public kustomize base and the staging/production overlays.
 *
 *   node scripts/check-k8s-overlays.mjs --source
 *   node scripts/check-k8s-overlays.mjs <dir-with-rendered-yaml>
 *
 * The rendered directory must contain staging.yaml, production.yaml,
 * staging-jobs.yaml and production-jobs.yaml.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function readTree(dir) {
  let out = '';
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out += readTree(full);
    else out += `\n${readFileSync(full, 'utf8')}`;
  }
  return out;
}

/** True when the production hostname appears outside the staging host. */
function hasProductionHost(text) {
  return /(?<!staging\.)blakpath\.yumait\.au/.test(text);
}

function missing(errors, label, text, tokens) {
  for (const token of tokens) {
    if (!text.includes(token)) errors.push(`${label} missing ${token}`);
  }
}

function forbidden(errors, label, text, tokens) {
  for (const token of tokens) {
    if (text.includes(token)) errors.push(`${label} contains ${token}`);
  }
}

/** Account ids and key ARNs must not be committed. Patterns, not stored values. */
function identifierErrors(label, text) {
  const errors = [];
  if (/\b\d{12}\b/.test(text)) errors.push(`${label} contains a 12-digit account id`);
  if (text.includes('arn:aws:')) errors.push(`${label} contains an AWS ARN`);
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) {
    errors.push(`${label} contains a key id`);
  }
  return errors;
}

function sourceErrors(root) {
  const errors = [];
  const base = readTree(path.join(root, 'infra/k8s/base'));
  const staging = readTree(path.join(root, 'infra/k8s/overlays/staging'));
  const production = readTree(path.join(root, 'infra/k8s/overlays/production'));
  const runbook = readFileSync(path.join(root, 'docs/eks-runbook.md'), 'utf8');

  errors.push(...identifierErrors('k8s manifests', base + staging + production));
  forbidden(errors, 'k8s manifests', base + staging + production, [
    'blakpath-prod-evidence',
    'blakpath-prod-quarantine',
  ]);
  if (/\b\d{12}\b/.test(runbook)) errors.push('runbook contains a 12-digit account id');
  forbidden(errors, 'runbook', runbook, ['blakpath-eks-runtime', 'WAF ACL ARN']);
  if (hasProductionHost(base)) errors.push('base contains the production host');
  forbidden(errors, 'base', base, [
    '/blakpath/production/',
    '/blakpath/staging/',
    '__ECR_REGISTRY__',
    '__STAGING_',
    '__PRODUCTION_',
  ]);
  missing(errors, 'base', base, [
    'aws-secretsmanager',
    'name: blakpath-runtime',
    'blakpath/app:unset',
  ]);

  missing(errors, 'staging overlay', staging, [
    'namespace: blakpath-staging',
    '/blakpath/staging/runtime',
    'staging.blakpath.yumait.au',
    '__STAGING_S3_BUCKET_EVIDENCE__',
    '__STAGING_S3_BUCKET_QUARANTINE__',
    '__STAGING_S3_KMS_KEY_ID__',
    '__ECR_REGISTRY__',
    '__IMAGE_TAG__',
  ]);
  if (hasProductionHost(staging))
    errors.push('staging overlay contains the production host');
  forbidden(errors, 'staging overlay', staging, [
    '/blakpath/production/',
    '__PRODUCTION_',
    'blakpath-prod-evidence',
    'blakpath-prod-quarantine',
  ]);

  missing(errors, 'production overlay', production, [
    'namespace: blakpath\n',
    '/blakpath/production/runtime',
    'https://blakpath.yumait.au',
    '__PRODUCTION_S3_BUCKET_EVIDENCE__',
    '__PRODUCTION_S3_BUCKET_QUARANTINE__',
    '__PRODUCTION_S3_KMS_KEY_ID__',
    '__ECR_REGISTRY__',
    '__IMAGE_TAG__',
  ]);
  forbidden(errors, 'production overlay', production, [
    'blakpath-staging',
    '/blakpath/staging/',
    '__STAGING_',
  ]);

  missing(errors, 'runbook', runbook, [
    'aws-secretsmanager',
    '/blakpath/production/runtime',
    '/blakpath/staging/runtime',
    'blakpath-runtime',
    'infra/k8s/overlays/staging',
    'infra/k8s/overlays/production',
    '__STAGING_S3_KMS_KEY_ID__',
    '__PRODUCTION_S3_KMS_KEY_ID__',
    '__STAGING_S3_BUCKET_EVIDENCE__',
    '__PRODUCTION_S3_BUCKET_EVIDENCE__',
    '__ECR_REGISTRY__',
    '__IMAGE_TAG__',
  ]);
  return errors;
}

function renderedErrors(staging, production) {
  const errors = [];
  errors.push(...identifierErrors('rendered staging', staging));
  forbidden(errors, 'rendered staging', staging, [
    '/blakpath/production/',
    '__PRODUCTION_',
    'blakpath-prod-evidence',
    'blakpath-prod-quarantine',
    'placeholder.invalid',
    'REPLACE_VIA_OVERLAY',
    'blakpath/app:unset',
    'blakpath/worker:unset',
  ]);
  if (hasProductionHost(staging))
    errors.push('rendered staging contains the production host');
  missing(errors, 'rendered staging', staging, [
    'namespace: blakpath-staging',
    '/blakpath/staging/runtime',
    'staging.blakpath.yumait.au',
    '__STAGING_S3_BUCKET_EVIDENCE__',
    '__STAGING_S3_BUCKET_QUARANTINE__',
    '__STAGING_S3_KMS_KEY_ID__',
    '__ECR_REGISTRY__/blakpath/app:__IMAGE_TAG__',
    '__ECR_REGISTRY__/blakpath/worker:__IMAGE_TAG__',
    'aws-secretsmanager',
    'name: blakpath-staging',
  ]);

  errors.push(...identifierErrors('rendered production', production));
  forbidden(errors, 'rendered production', production, [
    'blakpath-staging',
    '/blakpath/staging/',
    '__STAGING_',
    'placeholder.invalid',
    'REPLACE_VIA_OVERLAY',
    'blakpath/app:unset',
    'blakpath/worker:unset',
  ]);
  missing(errors, 'rendered production', production, [
    'namespace: blakpath\n',
    'name: blakpath\n',
    '/blakpath/production/runtime',
    'https://blakpath.yumait.au',
    'host: blakpath.yumait.au',
    '__PRODUCTION_S3_BUCKET_EVIDENCE__',
    '__PRODUCTION_S3_BUCKET_QUARANTINE__',
    '__PRODUCTION_S3_KMS_KEY_ID__',
    '__ECR_REGISTRY__/blakpath/app:__IMAGE_TAG__',
    '__ECR_REGISTRY__/blakpath/worker:__IMAGE_TAG__',
    'aws-secretsmanager',
  ]);
  return errors;
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node scripts/check-k8s-overlays.mjs --source|<rendered-dir>');
    process.exit(2);
  }
  const errors = sourceErrors(process.cwd());
  if (arg !== '--source') {
    const staging =
      readFileSync(path.join(arg, 'staging.yaml'), 'utf8') +
      readFileSync(path.join(arg, 'staging-jobs.yaml'), 'utf8');
    const production =
      readFileSync(path.join(arg, 'production.yaml'), 'utf8') +
      readFileSync(path.join(arg, 'production-jobs.yaml'), 'utf8');
    errors.push(...renderedErrors(staging, production));
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log('kustomize overlays ok');
}

main();
