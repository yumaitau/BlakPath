import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function documents(yaml: string): string[] {
  return yaml
    .split(/^---$/m)
    .map((doc) => doc.trim())
    .filter((doc) => /^apiVersion:/m.test(doc));
}

function kindOf(doc: string): string | undefined {
  return /^kind:\s*(\S+)/m.exec(doc)?.[1];
}

function nameOf(doc: string): string | undefined {
  return /^metadata:\n(?:.*\n)*?  name:\s*(\S+)/m.exec(doc)?.[1];
}

function actions(block: string): string[] {
  const found = new Set<string>();
  const lines = block.split('\n');
  let inAction = false;
  let actionIndent = 0;
  for (const line of lines) {
    const single = /^(\s*)Action:\s+((?:s3|kms|ses|sts):[A-Za-z]+)\s*$/.exec(line);
    const singleAction = single?.[2];
    if (singleAction) {
      found.add(singleAction);
      inAction = false;
      continue;
    }
    if (/^\s*Action:\s*$/.test(line)) {
      inAction = true;
      actionIndent = line.search(/\S/);
      continue;
    }
    if (!inAction) continue;
    const item = /^(\s*)-\s+((?:s3|kms|ses|sts):[A-Za-z]+)\s*$/.exec(line);
    const indent = item?.[1];
    const itemAction = item?.[2];
    if (indent && itemAction && indent.length > actionIndent) {
      found.add(itemAction);
      continue;
    }
    inAction = false;
  }
  return [...found].sort();
}

function sliceBetween(text: string, start: string, end: string | null): string {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(from);
  if (!end) return rest;
  const to = rest.indexOf(end, start.length);
  expect(to, end).toBeGreaterThan(0);
  return rest.slice(0, to);
}

const podFiles = [
  'infra/k8s/web-deployment.yaml',
  'infra/k8s/worker-deployment.yaml',
  'infra/k8s/jobs/migrate.yaml',
  'infra/k8s/jobs/seed.yaml',
];

describe('pod security and workload identities', () => {
  const pods = podFiles.flatMap((path) =>
    documents(read(path))
      .filter((doc) => kindOf(doc) === 'Deployment' || kindOf(doc) === 'Job')
      .map((doc) => ({ path, doc, name: nameOf(doc) })),
  );

  it('enforces restricted Pod Security Admission on the namespace', () => {
    const namespace = read('infra/k8s/namespace.yaml');
    expect(namespace).toContain('pod-security.kubernetes.io/enforce: restricted');
    expect(namespace).toContain('name: blakpath');
  });

  it('admits every workload pod under the restricted profile', () => {
    expect(pods.map((pod) => pod.name).sort()).toEqual([
      'blakpath-app',
      'blakpath-clamav',
      'blakpath-migrate',
      'blakpath-seed',
      'blakpath-worker',
    ]);

    for (const pod of pods) {
      expect(pod.doc, pod.name).toContain('runAsNonRoot: true');
      expect(pod.doc, pod.name).toContain('allowPrivilegeEscalation: false');
      expect(pod.doc, pod.name).toContain('drop: [ALL]');
      expect(pod.doc, pod.name).toMatch(/seccompProfile:\n\s+type: RuntimeDefault/);
      expect(pod.doc, pod.name).not.toContain('privileged: true');
      expect(pod.doc, pod.name).not.toContain('hostNetwork:');
      expect(pod.doc, pod.name).not.toContain('hostPath:');
      expect(pod.doc, pod.name).not.toMatch(/runAsUser:\s*0\b/);
    }
  });

  it('runs web and worker with a read-only root filesystem', () => {
    const web = pods.find((pod) => pod.name === 'blakpath-app');
    const worker = pods.find((pod) => pod.name === 'blakpath-worker');
    expect(web?.doc).toContain('readOnlyRootFilesystem: true');
    expect(web?.doc).toContain('mountPath: /tmp');
    expect(web?.doc).toContain('serviceAccountName: blakpath-web');
    expect(worker?.doc).toContain('readOnlyRootFilesystem: true');
    expect(worker?.doc).toContain('mountPath: /tmp');
    expect(worker?.doc).toContain('serviceAccountName: blakpath-worker');
  });

  it('gives ClamAV and jobs no AWS credentials', () => {
    const accounts = read('infra/k8s/serviceaccounts.yaml');
    expect(accounts).toContain('name: blakpath-web');
    expect(accounts).toContain('name: blakpath-worker');
    expect(accounts).toContain('name: blakpath-clamav');
    expect(accounts).toContain('name: blakpath-migrate');
    expect(accounts).not.toMatch(/^  name: blakpath$/m);

    const clamavAccount = sliceBetween(
      accounts,
      'name: blakpath-clamav',
      'name: blakpath-migrate',
    );
    const migrateAccount = sliceBetween(accounts, 'name: blakpath-migrate', null);
    expect(clamavAccount).toContain('automountServiceAccountToken: false');
    expect(migrateAccount).toContain('automountServiceAccountToken: false');

    const clamav = pods.find((pod) => pod.name === 'blakpath-clamav');
    expect(clamav?.doc).toContain('serviceAccountName: blakpath-clamav');
    expect(clamav?.doc).toContain('automountServiceAccountToken: false');
    expect(clamav?.doc).toContain('command: [/init-unprivileged]');
    expect(clamav?.doc).toContain('runAsUser: 1000');
    expect(clamav?.doc).not.toContain('readOnlyRootFilesystem:');

    for (const name of ['blakpath-migrate', 'blakpath-seed']) {
      const job = pods.find((pod) => pod.name === name);
      expect(job?.doc, name).toContain('serviceAccountName: blakpath-migrate');
      expect(job?.doc, name).toContain('automountServiceAccountToken: false');
      expect(job?.doc, name).toContain('readOnlyRootFilesystem: true');
    }

    const rendered = podFiles.map((path) => read(path)).join('\n');
    expect(rendered).not.toMatch(/serviceAccountName: blakpath$/m);
  });
});

describe('EKS Pod Identity roles', () => {
  const roles = read('infra/aws/workload-roles.example.yaml');
  const web = sliceBetween(roles, 'WebWorkloadRole:', 'WorkerWorkloadRole:');
  const worker = sliceBetween(roles, 'WorkerWorkloadRole:', 'WebPodIdentity:');
  const webPolicy = sliceBetween(web, 'Policies:', null);
  const workerPolicy = sliceBetween(worker, 'Policies:', null);
  const webAllow = sliceBetween(webPolicy, 'Statement:', 'Sid: DenyEvidenceDelete');
  const webDeny = sliceBetween(webPolicy, 'Sid: DenyEvidenceDelete', null);
  const workerAllow = sliceBetween(workerPolicy, 'Statement:', 'Sid: DenyCoaSigning');
  const workerDeny = sliceBetween(workerPolicy, 'Sid: DenyCoaSigning', null);

  it('trusts pods.eks.amazonaws.com for web and worker only', () => {
    expect(roles).not.toContain('ecs-tasks.amazonaws.com');
    expect(roles).not.toContain('secretsmanager:');
    expect(roles).not.toContain('TaskExecution');
    expect(roles).not.toContain('blakpath-clamav');
    expect(roles).not.toContain('blakpath-migrate');
    expect(roles).not.toContain('DisableSessionTags: true');

    for (const role of [web, worker]) {
      const trust = sliceBetween(role, 'AssumeRolePolicyDocument:', 'Policies:');
      expect(actions(trust)).toEqual(['sts:AssumeRole', 'sts:TagSession']);
      expect(trust).toContain('Service: pods.eks.amazonaws.com');
      expect(trust).toContain("'aws:RequestTag/kubernetes-namespace': blakpath");
    }

    expect(web).toContain("'aws:RequestTag/kubernetes-service-account': blakpath-web");
    expect(worker).toContain(
      "'aws:RequestTag/kubernetes-service-account': blakpath-worker",
    );
    expect(roles).toContain('ServiceAccount: blakpath-web');
    expect(roles).toContain('ServiceAccount: blakpath-worker');
    expect(roles.match(/AWS::EKS::PodIdentityAssociation/g)).toHaveLength(2);
  });

  it('keeps evidence delete off the web role and kms:Sign off the worker role', () => {
    expect(actions(webAllow)).toEqual([
      'kms:Decrypt',
      'kms:GenerateDataKey',
      'kms:GetPublicKey',
      'kms:Sign',
      's3:GetObject',
      's3:ListBucket',
      's3:PutObject',
      'ses:SendEmail',
    ]);
    expect(actions(webDeny)).toEqual(['s3:DeleteObject', 's3:DeleteObjectVersion']);
    expect(webAllow).toContain('${EvidenceBucketArn}/*/certificates/*');
    expect(webAllow).not.toContain('s3:DeleteObject');

    expect(actions(workerAllow)).toEqual([
      'kms:Decrypt',
      'kms:GenerateDataKey',
      's3:DeleteObject',
      's3:GetObject',
      's3:PutObject',
      'ses:SendEmail',
    ]);
    expect(actions(workerDeny)).toEqual(['kms:Sign']);
    expect(workerDeny).toContain("Resource: '*'");
    expect(workerPolicy).not.toContain('certificates');
    expect(workerPolicy).not.toContain('s3:ListBucket');
    expect(workerPolicy).not.toContain('kms:GetPublicKey');

    for (const policy of [webPolicy, workerPolicy]) {
      expect(policy).toContain("'kms:ViaService'");
      expect(policy).not.toContain('kms:Encrypt');
      expect(policy).not.toContain('kms:Verify');
      expect(policy).not.toContain('kms:DescribeKey');
    }
  });

  it('records an unused-access analyzer and the per-role review', () => {
    const analyzer = read('infra/aws/unused-access-analyzer.example.yaml');
    expect(analyzer).toContain('Type: ACCOUNT_UNUSED_ACCESS');
    expect(analyzer).toContain('UnusedAccessAge: 90');

    const review = read('infra/aws/unused-access-review.md');
    expect(review).toContain('blakpath-web');
    expect(review).toContain('blakpath-worker');
    expect(review).toContain('blakpath-clamav');
    expect(review).toContain('Explicit deny');
    expect(review).toContain('kms:Sign');
  });
});
