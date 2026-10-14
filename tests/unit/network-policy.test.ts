import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

/** Split a multi-doc manifest into name → body. Names are unique in this set. */
function documents(yaml: string): Map<string, string> {
  const docs = new Map<string, string>();
  for (const doc of yaml.split(/^---$/m)) {
    const name = doc.match(/^  name: ([^\n]+)$/m)?.[1];
    if (!name) continue;
    if (docs.has(name)) throw new Error(`duplicate manifest name ${name}`);
    docs.set(name, doc);
  }
  return docs;
}

const policies = documents(read('infra/k8s/network-policy.yaml'));

function policy(name: string): string {
  const doc = policies.get(name);
  if (!doc) throw new Error(`missing policy ${name}`);
  return doc;
}

describe('blakpath network policy', () => {
  it('is on the kustomize path and the controller manifest', () => {
    expect(read('infra/k8s/kustomization.yaml')).toContain('network-policy.yaml');
    expect(read('.github/workflows/ci.yml')).toContain(
      'kubectl kustomize infra/k8s/cluster',
    );
    const controller = read('infra/k8s/cluster/enable-network-policy.yaml');
    expect(controller).toContain('namespace: kube-system');
    expect(controller).toContain("enable-network-policy-controller: 'true'");
    expect(read('infra/k8s/cluster/kustomization.yaml')).not.toContain(
      'namespace: blakpath',
    );
  });

  it('default-denies every pod in the namespace', () => {
    const deny = policy('blakpath-default-deny');
    expect(deny).toContain('podSelector: {}');
    expect(deny).toContain('Ingress');
    expect(deny).toContain('Egress');
    expect(deny).not.toContain('ports:');
    expect(deny).not.toContain('ipBlock:');
    expect(deny).not.toContain('namespaceSelector:');
  });

  it('lets only the ALB path hit web, on the container port', () => {
    const ingress = policy('blakpath-web-ingress');
    expect(ingress).toContain('app.kubernetes.io/name: blakpath-app');
    expect(ingress).toContain('port: 3000');
    expect(ingress).toContain('cidr: 0.0.0.0/0');
    expect(ingress).not.toContain('namespaceSelector:');
    expect(ingress).not.toContain('podSelector:\n            matchLabels:');

    const service = read('infra/k8s/service-ingress.yaml');
    expect(service).toContain('port: 3000');
    expect(service).toContain('number: 3000');
    expect(service).not.toMatch(/port: 80\b/);
  });

  it('lets only web and worker reach ClamAV', () => {
    // Ingress lives with the workload in clamav.yaml.
    const ingress =
      read('infra/k8s/clamav.yaml')
        .split(/^---$/m)
        .find((doc) => doc.includes('kind: NetworkPolicy')) ?? '';
    const ingressRules = ingress.slice(0, ingress.indexOf('  egress:'));
    expect(ingress).toContain('kind: NetworkPolicy');
    expect(ingressRules).toContain('app.kubernetes.io/name: blakpath-app');
    expect(ingressRules).toContain('app.kubernetes.io/name: blakpath-worker');
    expect(ingressRules).toContain('port: 3310');
    expect(ingressRules).not.toContain('ipBlock:');
    expect(ingressRules).not.toContain('namespaceSelector:');

    const egress = policy('blakpath-to-clamav');
    expect(egress).toContain('blakpath-app');
    expect(egress).toContain('blakpath-worker');
    expect(egress).toContain('blakpath-clamav');
    expect(egress).toContain('port: 3310');
    expect(egress).not.toContain('blakpath-job');
    expect(egress).not.toContain('namespaceSelector:');
  });

  it('allows DNS and Pod Identity, and does not open IMDS', () => {
    const dns = policy('blakpath-dns');
    expect(dns).toContain('cidr: 172.20.0.10/32');
    expect(dns).toContain('cidr: 10.100.0.10/32');
    expect(dns).toContain('port: 53');
    expect(dns).toContain('kubernetes.io/metadata.name: kube-system');
    for (const workload of [
      'blakpath-app',
      'blakpath-worker',
      'blakpath-clamav',
      'blakpath-clamav-mirror',
      'blakpath-job',
      'blakpath-admin-job',
    ]) {
      expect(dns).toContain(`- ${workload}\n`);
    }

    const identity = policy('blakpath-pod-identity');
    expect(identity).toContain('cidr: 169.254.170.23/32');
    expect(identity).toContain('port: 80');
    expect(identity).toContain('- blakpath-admin-job\n');
    expect(identity).not.toContain('blakpath-clamav');
    expect(identity).not.toContain('- blakpath-job\n');
    expect(identity).not.toContain('169.254.169.254');

    expect(read('infra/k8s/network-policy.yaml')).not.toContain('169.254.169.254');
  });

  it('pins web egress to named dependencies and not the open internet', () => {
    const web = policy('blakpath-web-egress');
    expect(web).toContain('kind: ApplicationNetworkPolicy');
    expect(web).toContain('app.kubernetes.io/name: blakpath-app');
    for (const host of [
      '*.rds.amazonaws.com',
      '*.cache.amazonaws.com',
      's3.ap-southeast-2.amazonaws.com',
      '*.s3.ap-southeast-2.amazonaws.com',
      'kms.ap-southeast-2.amazonaws.com',
      'secretsmanager.ap-southeast-2.amazonaws.com',
      'sts.ap-southeast-2.amazonaws.com',
      'email.ap-southeast-2.amazonaws.com',
      'sns.ap-southeast-2.amazonaws.com',
      'login.microsoftonline.com',
    ]) {
      expect(web).toContain(host);
    }
    expect(web).toContain('port: 5432');
    expect(web).toContain('port: 6379');
    expect(web).toContain('port: 443');
    // SES v2 API only (ADR 0090): no SMTP relay, no PaperBoy.
    expect(web).not.toContain('port: 587');
    expect(web).not.toContain('email-smtp');
    expect(web).not.toContain('paperboy');
    expect(web).not.toContain('0.0.0.0/0');
    expect(web).not.toContain('blakpath-worker');
  });

  it('limits webhook and public egress to the worker, outside the VPC', () => {
    const worker = policy('blakpath-worker-egress');
    expect(worker).toContain('app.kubernetes.io/name: blakpath-worker');
    expect(worker).not.toContain('blakpath-app');
    expect(worker).not.toContain('domainNames:');
    expect(worker).toContain('port: 5432');
    expect(worker).toContain('port: 6379');
    expect(worker).toContain('port: 443');
    expect(worker).not.toContain('port: 587');
    expect(worker).toContain('cidr: 0.0.0.0/0');
    for (const excluded of [
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '169.254.0.0/16',
      '100.64.0.0/10',
      '127.0.0.0/8',
    ]) {
      expect(worker).toContain(excluded);
    }
    expect(worker).not.toContain('namespaceSelector:');

    // The scanner talks only to the in-namespace mirror (clamav.yaml); the
    // mirror is the one ClamAV pod with public 80/443, never private ranges.
    const scanner = read('infra/k8s/clamav.yaml');
    expect(scanner).not.toContain('0.0.0.0/0');
    expect(scanner).toContain('app.kubernetes.io/name: blakpath-clamav-mirror');
    const mirror = read('infra/k8s/clamav-mirror.yaml');
    for (const excluded of [
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '169.254.0.0/16',
    ]) {
      expect(mirror).toContain(`- ${excluded}`);
    }
    expect(mirror).not.toContain('port: 5432');

    const job = policy('blakpath-job-egress');
    expect(job).toContain('blakpath-job');
    expect(job).toContain('port: 5432');
    expect(job).not.toContain('port: 443');
    expect(job).not.toContain('port: 6379');

    const admin = policy('blakpath-admin-job-egress');
    expect(admin).toContain('app.kubernetes.io/name: blakpath-admin-job');
    // provision-organisation shares the admin-job label and its egress.
    expect(read('infra/k8s/jobs/provision-organisation.yaml')).toContain(
      'app.kubernetes.io/name: blakpath-admin-job',
    );
    expect(admin).toContain('email.ap-southeast-2.amazonaws.com');
    expect(admin).toContain('port: 5432');
    expect(admin).not.toContain('port: 6379');
    expect(admin).not.toContain('0.0.0.0/0');
  });

  it('selects every workload in infra/k8s with at least one allow policy', () => {
    // Every manifest under infra/k8s, including the jobs/ and release-check/
    // directories that are applied outside the main kustomization.
    const manifests = readdirSync(resolve(root, 'infra/k8s'), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.yaml'));
    // Pod selectors of every allow policy other than default-deny and DNS.
    const selectors = [
      read('infra/k8s/network-policy.yaml'),
      read('infra/k8s/clamav.yaml'),
      read('infra/k8s/clamav-mirror.yaml'),
    ]
      .join('\n---\n')
      .split(/^---$/m)
      .filter((doc) => /^kind: (Application)?NetworkPolicy$/m.test(doc))
      .filter((doc) => !/name: blakpath-(default-deny|dns)$/m.test(doc))
      .map((doc) =>
        doc.slice(doc.indexOf('  podSelector:'), doc.indexOf('  policyTypes:')),
      );
    const seen: string[] = [];
    for (const file of manifests) {
      const workloads = read(`infra/k8s/${file}`)
        .split(/^---$/m)
        .filter((doc) =>
          /^kind: (Deployment|StatefulSet|DaemonSet|Job|CronJob)$/m.test(doc),
        );
      for (const doc of workloads) {
        seen.push(file);
        const template = doc.slice(doc.indexOf('  template:'));
        const label = template.match(/app\.kubernetes\.io\/name: (\S+)/)?.[1];
        expect(label, `${file} pod template label`).toBeTruthy();
        expect(policy('blakpath-dns'), `${file} DNS`).toContain(`- ${label}\n`);
        const selected = selectors.some(
          (sel) =>
            sel.includes(`app.kubernetes.io/name: ${label}\n`) ||
            sel.includes(`- ${label}\n`),
        );
        expect(selected, `${file} (${label}) selected by an allow policy`).toBe(true);
      }
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        'web-deployment.yaml',
        'worker-deployment.yaml',
        'clamav.yaml',
        'clamav-mirror.yaml',
        'jobs/migrate.yaml',
        'jobs/seed.yaml',
        'jobs/invite-admin.yaml',
        'release-check/job.yaml',
      ]),
    );
  });

  it('lets the release gate and per-release migrate Job reach only DNS and Postgres', () => {
    const job = policy('blakpath-job-egress');
    for (const label of ['blakpath-release-check', 'blakpath-migrate']) {
      expect(job).toContain(`- ${label}\n`);
      expect(policy('blakpath-dns')).toContain(`- ${label}\n`);
      expect(policy('blakpath-pod-identity')).not.toContain(label);
      expect(policy('blakpath-web-egress')).not.toContain(label);
      expect(policy('blakpath-worker-egress')).not.toContain(label);
    }
  });
});
