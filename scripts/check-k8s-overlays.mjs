#!/usr/bin/env node
/**
 * Checks the public kustomize base and the staging/production overlays.
 *
 *   node scripts/check-k8s-overlays.mjs --source
 *   node scripts/check-k8s-overlays.mjs <dir-with-rendered-yaml>
 *
 * The rendered directory must contain <env>.yaml, <env>-jobs.yaml and
 * <env>-release-check.yaml for staging and production.
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

/**
 * True when the production hostname appears outside the staging host. A
 * label or annotation key prefix (`blakpath.yumait.au/release:`) is not a host.
 */
function hasProductionHost(text) {
  return /(?<!staging\.)blakpath\.yumait\.au(?!\/[\w.-]+:)/.test(text);
}

/** Production identities that a staging render must never name. */
const PRODUCTION_ONLY = [
  'role/blakpath-external-secrets',
  ':blakpath-email-events',
  'SES_CONFIGURATION_SET: blakpath-production',
];

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

/**
 * ARN account fields that are placeholders, not account ids. `__AWS_ACCOUNT_ID__`
 * is substituted by scripts/eks-deploy.sh. `ACCOUNT_ID` is the hand-filled
 * placeholder in the ingress annotations (docs/eks-runbook.md, Edge and origin).
 */
const ARN_ACCOUNT_PLACEHOLDER = /^(?:__AWS_ACCOUNT_ID__|ACCOUNT_ID)$/;

/** ARNs whose account field is empty or a real value. */
function concreteArns(text) {
  return [...text.matchAll(/arn:aws[\w-]*:[\w-]*:[\w-]*:([^:\s'"]*):/g)].filter(
    (match) => !ARN_ACCOUNT_PLACEHOLDER.test(match[1] ?? ''),
  );
}

/** Account ids and key ARNs must not be committed. Patterns, not stored values. */
function identifierErrors(label, text) {
  const errors = [];
  if (/\b\d{12}\b/.test(text)) errors.push(`${label} contains a 12-digit account id`);
  if (concreteArns(text).length > 0) errors.push(`${label} contains an AWS ARN`);
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
  const cluster = readTree(path.join(root, 'infra/k8s/cluster'));
  const runbook = readFileSync(path.join(root, 'docs/eks-runbook.md'), 'utf8');

  errors.push(
    ...identifierErrors('k8s manifests', base + staging + production + cluster),
  );
  forbidden(errors, 'k8s manifests', base + staging + production, [
    'blakpath-prod-evidence',
    'blakpath-prod-quarantine',
  ]);
  if (/\b\d{12}\b/.test(runbook)) errors.push('runbook contains a 12-digit account id');
  // The root kustomization is gone. Render an overlay instead.
  forbidden(errors, 'runbook', runbook, [
    'kubectl kustomize infra/k8s |',
    'kubectl apply -k infra/k8s ',
  ]);
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
    'name: blakpath-secrets',
    'name: blakpath-runtime',
    'blakpath/app:unset',
    'blakpath/worker:unset',
  ]);

  missing(errors, 'staging overlay', staging, [
    'namespace: blakpath-staging',
    '/blakpath/staging/runtime',
    '/blakpath/staging/migrator',
    'staging.blakpath.yumait.au',
    '__STAGING_S3_BUCKET_EVIDENCE__',
    '__STAGING_S3_BUCKET_QUARANTINE__',
    '__STAGING_S3_BUCKET_AUDIT_ANCHORS__',
    '__STAGING_S3_KMS_KEY_ID__',
    'role/blakpath-staging-external-secrets',
    'SES_CONFIGURATION_SET: blakpath-staging',
    '__ECR_REGISTRY__',
    '__IMAGE_TAG__',
  ]);
  if (hasProductionHost(staging))
    errors.push('staging overlay contains the production host');
  forbidden(errors, 'staging overlay', staging, [
    '/blakpath/production/',
    '__PRODUCTION_',
    ...PRODUCTION_ONLY,
    'blakpath-prod-evidence',
    'blakpath-prod-quarantine',
  ]);

  missing(errors, 'production overlay', production, [
    'namespace: blakpath\n',
    '/blakpath/production/runtime',
    '/blakpath/production/migrator',
    'https://blakpath.yumait.au',
    '__PRODUCTION_S3_BUCKET_EVIDENCE__',
    '__PRODUCTION_S3_BUCKET_QUARANTINE__',
    '__PRODUCTION_S3_BUCKET_AUDIT_ANCHORS__',
    '__PRODUCTION_S3_KMS_KEY_ID__',
    ...PRODUCTION_ONLY,
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
    '__AWS_ACCOUNT_ID__',
    '__PRODUCTION_S3_BUCKET_AUDIT_ANCHORS__',
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
    ...PRODUCTION_ONLY,
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
    '/blakpath/staging/migrator',
    'staging.blakpath.yumait.au',
    '__STAGING_S3_BUCKET_EVIDENCE__',
    '__STAGING_S3_BUCKET_QUARANTINE__',
    '__STAGING_S3_BUCKET_AUDIT_ANCHORS__',
    '__STAGING_S3_KMS_KEY_ID__',
    'role/blakpath-staging-external-secrets',
    'name: blakpath-release-check',
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
    '/blakpath/production/migrator',
    'https://blakpath.yumait.au',
    'host: blakpath.yumait.au',
    '__PRODUCTION_S3_BUCKET_EVIDENCE__',
    '__PRODUCTION_S3_BUCKET_QUARANTINE__',
    '__PRODUCTION_S3_BUCKET_AUDIT_ANCHORS__',
    '__PRODUCTION_S3_KMS_KEY_ID__',
    ...PRODUCTION_ONLY,
    'name: blakpath-release-check',
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
    const rendered = (env) =>
      ['', '-jobs', '-release-check']
        .map((suffix) => readFileSync(path.join(arg, `${env}${suffix}.yaml`), 'utf8'))
        .join('\n---\n');
    errors.push(...renderedErrors(rendered('staging'), rendered('production')));
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log('kustomize overlays ok');
}

main();
