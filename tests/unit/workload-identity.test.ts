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

/** Policy statements keyed by Sid. */
function statements(policy: string): Map<string, string> {
  const found = new Map<string, string>();
  const parts = policy.split(/^\s*- Sid:\s*/m).slice(1);
  for (const part of parts) {
    const sid = part.split('\n', 1)[0]?.trim() ?? '';
    found.set(sid, part);
  }
  return found;
}

function allowedActions(policy: string): string[] {
  const found = new Set<string>();
  for (const body of statements(policy).values()) {
    if (!/^\s*Effect:\s*Allow\s*$/m.test(body)) continue;
    for (const action of actions(body)) found.add(action);
  }
  return [...found].sort();
}

function deniedActions(policy: string): string[] {
  const found = new Set<string>();
  for (const body of statements(policy).values()) {
    if (!/^\s*Effect:\s*Deny\s*$/m.test(body)) continue;
    for (const action of actions(body)) found.add(action);
  }
  return [...found].sort();
}

const podFiles = [
  'infra/k8s/web-deployment.yaml',
  'infra/k8s/worker-deployment.yaml',
  'infra/k8s/clamav.yaml',
  'infra/k8s/clamav-mirror.yaml',
  'infra/k8s/jobs/migrate.yaml',
  'infra/k8s/jobs/seed.yaml',
  'infra/k8s/jobs/invite-admin.yaml',
  'infra/k8s/release-check/job.yaml',
];

const podKinds = new Set(['Deployment', 'StatefulSet', 'Job']);

describe('pod security and workload identities', () => {
  const pods = podFiles.flatMap((path) =>
    documents(read(path))
      .filter((doc) => podKinds.has(kindOf(doc) ?? ''))
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
      'blakpath-clamav-mirror',
      'blakpath-invite-admin',
      'blakpath-migrate',
      'blakpath-release-check',
      'blakpath-seed',
      'blakpath-worker',
    ]);

    for (const pod of pods) {
      expect(pod.doc, pod.name).toContain('runAsNonRoot: true');
      expect(pod.doc, pod.name).toContain('allowPrivilegeEscalation: false');
      expect(pod.doc, pod.name).toContain('drop: [ALL]');
      expect(pod.doc, pod.name).toContain('readOnlyRootFilesystem: true');
      expect(pod.doc, pod.name).toMatch(/seccompProfile:\n\s+type: RuntimeDefault/);
      expect(pod.doc, pod.name).not.toContain('privileged: true');
      expect(pod.doc, pod.name).not.toContain('hostNetwork:');
      expect(pod.doc, pod.name).not.toContain('hostPath:');
      expect(pod.doc, pod.name).not.toMatch(/runAsUser:\s*0\b/);
    }
  });

  it('runs web, worker and jobs with a writable /tmp only', () => {
    for (const name of [
      'blakpath-app',
      'blakpath-worker',
      'blakpath-migrate',
      'blakpath-seed',
      'blakpath-invite-admin',
    ]) {
      const pod = pods.find((candidate) => candidate.name === name);
      expect(pod?.doc, name).toContain('mountPath: /tmp');
    }
    const web = pods.find((pod) => pod.name === 'blakpath-app');
    const worker = pods.find((pod) => pod.name === 'blakpath-worker');
    expect(web?.doc).toContain('serviceAccountName: blakpath-web');
    expect(worker?.doc).toContain('serviceAccountName: blakpath-worker');
  });

  it('gives ClamAV and the database jobs no AWS credentials', () => {
    const accounts = read('infra/k8s/serviceaccounts.yaml');
    expect(accounts).toContain('name: blakpath-web');
    expect(accounts).toContain('name: blakpath-worker');
    expect(accounts).toContain('name: blakpath-migrate');
    expect(accounts).not.toMatch(/^ {2}name: blakpath$/m);

    const migrateAccount = sliceBetween(
      accounts,
      'name: blakpath-migrate',
      'name: blakpath-external-secrets',
    );
    expect(migrateAccount).toContain('automountServiceAccountToken: false');

    const clamavAccount = documents(read('infra/k8s/clamav.yaml')).find(
      (doc) => kindOf(doc) === 'ServiceAccount',
    );
    expect(clamavAccount).toContain('name: blakpath-clamav');
    expect(clamavAccount).toContain('automountServiceAccountToken: false');
    expect(clamavAccount).not.toContain('eks.amazonaws.com/role-arn');

    for (const name of ['blakpath-clamav', 'blakpath-clamav-mirror']) {
      const pod = pods.find((candidate) => candidate.name === name);
      expect(pod?.doc, name).toContain('serviceAccountName: blakpath-clamav');
      expect(pod?.doc, name).toContain('automountServiceAccountToken: false');
      expect(pod?.doc, name).toContain("command: ['/init-unprivileged']");
      expect(pod?.doc, name).toContain('runAsUser: 1000');
    }

    for (const name of ['blakpath-migrate', 'blakpath-seed', 'blakpath-release-check']) {
      const job = pods.find((pod) => pod.name === name);
      expect(job?.doc, name).toContain('serviceAccountName: blakpath-migrate');
      expect(job?.doc, name).toContain('automountServiceAccountToken: false');
    }

    // Sends mail through SES, so it borrows the web identity.
    const invite = pods.find((pod) => pod.name === 'blakpath-invite-admin');
    expect(invite?.doc).toContain('serviceAccountName: blakpath-web');

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
  const webStatements = statements(webPolicy);
  const workerStatements = statements(workerPolicy);

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

  it('keeps evidence delete off the web role', () => {
    expect(allowedActions(webPolicy)).toEqual([
      'kms:Decrypt',
      'kms:Encrypt',
      'kms:GenerateDataKey',
      'kms:GetPublicKey',
      'kms:Sign',
      's3:GetObject',
      's3:ListBucket',
      's3:PutObject',
    ]);
    expect(deniedActions(webPolicy)).toEqual([
      's3:DeleteObject',
      's3:DeleteObjectVersion',
    ]);
    expect(webStatements.get('DenyEvidenceDelete')).toContain("'${EvidenceBucketArn}/*'");
    expect(webStatements.get('CertificatePdfWrite')).toContain(
      '${EvidenceBucketArn}/*/certificates/*',
    );
    expect(webStatements.get('CoaSignAndPublicKey')).toContain(
      'Resource: !Ref CoaSigningKeyArn',
    );
    expect(webPolicy).not.toContain('AuditAnchor');
  });

  it('lets the worker sign only with the audit anchor key', () => {
    expect(allowedActions(workerPolicy)).toEqual([
      'kms:Decrypt',
      'kms:DescribeKey',
      'kms:Encrypt',
      'kms:GenerateDataKey',
      'kms:GetPublicKey',
      'kms:Sign',
      's3:DeleteObject',
      's3:GetObject',
      's3:ListBucket',
      's3:PutObject',
    ]);
    const signers = [...workerStatements.entries()].filter(
      ([, body]) => /^\s*Effect:\s*Allow\s*$/m.test(body) && body.includes('kms:Sign'),
    );
    expect(signers.map(([sid]) => sid)).toEqual(['AuditAnchorSign']);
    expect(workerStatements.get('AuditAnchorSign')).toContain(
      'Resource: !Ref AuditAnchorSigningKeyArn',
    );

    const denyCoa = workerStatements.get('DenyCoaSigning');
    expect(denyCoa).toMatch(/^\s*Effect:\s*Deny\s*$/m);
    expect(denyCoa).toContain('Action: kms:Sign');
    expect(denyCoa).toContain('NotResource: !Ref AuditAnchorSigningKeyArn');
    expect(deniedActions(workerPolicy)).toEqual([
      'kms:Sign',
      's3:BypassGovernanceRetention',
      's3:DeleteObject',
      's3:DeleteObjectVersion',
    ]);

    expect(workerPolicy).not.toContain('certificates');
    expect(workerPolicy).not.toContain('CoaSigningKeyArn');
    expect(workerStatements.get('AuditAnchorList')).toContain(
      'Resource: !Ref AuditAnchorBucketArn',
    );
  });

  it('scopes tenant kms:Encrypt by encryption context or S3', () => {
    for (const policy of [webStatements, workerStatements]) {
      for (const [sid, body] of policy) {
        if (!body.includes('kms:Encrypt')) continue;
        expect(body, sid).toMatch(/kms:EncryptionContext:(purpose|aws:s3:arn)/);
      }
    }
    for (const policy of [webPolicy, workerPolicy]) {
      expect(policy).toContain("'kms:ViaService'");
      expect(policy).not.toContain('kms:Verify');
      expect(policy).not.toContain('ses:');
    }
    expect(webStatements.get('TenantEnvelopeKeys')).toContain('- key_health');
    expect(workerStatements.get('TenantEnvelopeKeys')).not.toContain('key_health');
  });

  it('attaches mail send to the web and worker roles from one address', () => {
    const boundary = read('infra/aws/eks-boundary.example.yaml');
    const mail = sliceBetween(boundary, 'WorkloadMailSend:', 'Outputs:');
    expect(mail).toContain('- !Ref WebRoleName');
    expect(mail).toContain('- !Ref WorkerRoleName');
    expect(mail).toContain('ses:FromAddress');
    expect(boundary).toContain('Default: blakpath-web');
    expect(boundary).toContain('Default: blakpath-worker');
    expect(boundary).not.toContain('AWS::EKS::PodIdentityAssociation');
    expect(boundary).not.toContain('blakpath-eks-runtime');
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
