import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UNRESOLVED_DIGEST,
  auditImageSources,
  auditK8sDirectory,
  auditRenderedImages,
  kustomizationRoots,
  parseContainerImages,
} from '../../scripts/k8s-image-digests';

const root = '/repo/infra/k8s';
const app = '959038055523.dkr.ecr.ap-southeast-2.amazonaws.com/blakpath/app';
const worker = '959038055523.dkr.ecr.ap-southeast-2.amazonaws.com/blakpath/worker';
const resolved = `sha256:${'a'.repeat(64)}`;

function sources(pinDigest: { app: string; worker: string }, webImage = app) {
  return [
    {
      path: `${root}/components/images/kustomization.yaml`,
      text: `apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
images:
  - name: ${app}
    digest: ${pinDigest.app}
  - name: ${worker}
    digest: ${pinDigest.worker}
`,
    },
    {
      path: `${root}/web-deployment.yaml`,
      text: `containers:\n  - name: web\n    image: ${webImage}\n`,
    },
    {
      path: `${root}/worker-deployment.yaml`,
      text: `containers:\n  - name: worker\n    image: ${worker}\n`,
    },
    {
      path: `${root}/jobs/migrate.yaml`,
      text: `containers:\n  - name: migrate\n    image: ${worker}\n`,
    },
  ];
}

describe('k8s image digest audit', () => {
  it('accepts one digest pin shared by the worker and migrate', () => {
    const audit = auditImageSources(root, sources({ app: resolved, worker: resolved }));
    expect(audit.issues).toEqual([]);
    const image = (name: string) =>
      audit.containers.find((container) => container.container === name)?.resolved;
    expect(image('worker')).toBe(`${worker}@${resolved}`);
    expect(image('migrate')).toBe(image('worker'));
    expect(image('web')).toBe(`${app}@${resolved}`);
  });

  it('rejects mutable tags, newTag overrides and digest disagreements', () => {
    const tagged = auditImageSources(
      root,
      sources({ app: resolved, worker: resolved }, `${app}:538319c`),
    );
    expect(tagged.issues).toEqual([
      `web-deployment.yaml: web image uses a mutable tag (${app}:538319c)`,
    ]);

    const rollback = auditImageSources(root, [
      {
        path: `${root}/kustomization.yaml`,
        text: `images:\n  - name: ${app}\n    newTag: 7350f7c\n`,
      },
      {
        path: `${root}/web-deployment.yaml`,
        text: `containers:\n  - name: web\n    image: ${app}\n`,
      },
    ]);
    expect(rollback.issues.some((issue) => issue.includes('newTag (7350f7c)'))).toBe(
      true,
    );

    const otherDigest = `sha256:${'b'.repeat(64)}`;
    const drifted = auditImageSources(
      root,
      sources({ app: resolved, worker: resolved }, `${app}@${otherDigest}`),
    );
    expect(
      drifted.issues.some((issue) => issue.includes('disagrees with the kustomize pin')),
    ).toBe(true);
  });

  it('pairs names when kustomize prints image before name', () => {
    const parsed = parseContainerImages(
      'rendered',
      [
        '      containers:',
        '      - envFrom:',
        '        - configMapRef:',
        '            name: blakpath-config',
        `        image: ${app}@${resolved}`,
        '        name: web',
        `      - image: clamav/clamav-debian@sha256:${'c'.repeat(64)}`,
        '        name: clamav',
        '        ports:',
        '        - containerPort: 3310',
        '          name: clamav',
      ].join('\n'),
    );
    expect(parsed.map((container) => [container.container, container.image])).toEqual([
      ['web', `${app}@${resolved}`],
      ['clamav', `clamav/clamav-debian@sha256:${'c'.repeat(64)}`],
    ]);
  });

  it('rejects a rendered manifest that is not the kustomize pin', () => {
    const audit = auditImageSources(root, sources({ app: resolved, worker: resolved }));
    expect(
      auditRenderedImages(
        '        - name: web\n          image: nginx:latest\n',
        audit.containers,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('rendered manifest has no image for worker'),
        expect.stringContaining('nginx:latest'),
      ]),
    );
  });

  it('keeps the repo on one pin and reports only the unresolved BlakPath digests', () => {
    const audit = auditK8sDirectory(path.join(process.cwd(), 'infra/k8s'));
    const byName = Object.fromEntries(
      audit.containers.map((container) => [container.container, container.resolved]),
    );

    expect(audit.pins.filter((pin) => pin.newTag)).toEqual([]);
    expect(audit.containers.map((container) => container.image).join('\n')).not.toContain(
      '7350f7c',
    );
    expect(byName.worker).toBe(byName.migrate);
    expect(byName.worker).toBe(byName.seed);
    expect(byName.worker).toBe(byName['invite-admin']);
    expect(byName.web).toBe(`${app}@${UNRESOLVED_DIGEST}`);
    expect(byName.worker).toBe(`${worker}@${UNRESOLVED_DIGEST}`);
    expect(byName.clamav).toBe(
      'clamav/clamav-debian@sha256:1d4083fccfcd485cdaeee593db7655c923afdb8ed528e828d03e1c8b1e351bec',
    );
    // Replace with `toEqual([])` once both digests are real ECR imageDigests.
    expect(audit.issues).toEqual([
      `components/images/kustomization.yaml: ${app} digest is unresolved placeholder (${UNRESOLVED_DIGEST})`,
      `components/images/kustomization.yaml: ${worker} digest is unresolved placeholder (${UNRESOLVED_DIGEST})`,
    ]);
  });

  it('renders the root and the standalone invite-admin overlay, not the component', () => {
    const k8s = path.join(process.cwd(), 'infra/k8s');
    expect(kustomizationRoots(k8s).map((dir) => path.relative(k8s, dir))).toEqual([
      '',
      'jobs/invite-admin',
    ]);
  });

  it('declares immutable tags for both ECR repositories', () => {
    const template = readFileSync('infra/aws/ecr-repositories.example.yaml', 'utf8');
    expect(template).toContain('RepositoryName: blakpath/app');
    expect(template).toContain('RepositoryName: blakpath/worker');
    expect(template.match(/ImageTagMutability: IMMUTABLE/g)).toHaveLength(2);
  });
});
