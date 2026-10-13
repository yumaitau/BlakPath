import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderCdJob } from '@/lib/cd/jobs';
import {
  assertDigestImageRef,
  assertProductionReleaseRecord,
  assertRestorableImages,
  digestImageRef,
} from '@/lib/cd/images';
import {
  assertCdWorkflow,
  assertEksClusterName,
  assertOidcRoleArn,
  assertOidcTemplate,
  assertProductionEnvironment,
  assertTemporaryAwsCredentials,
  findAwsAccessKeyUsage,
  productionApprovalRequired,
} from '@/lib/cd/protection';
import { pollReady, readyAccepted, signInAccepted } from '@/lib/cd/smoke';
import {
  assertRuntimeSecretPath,
  assertSameAppUrl,
  failureAction,
} from '@/lib/cd/target';
import { planRelease, renderReleaseNotes } from '@/lib/cd/version';

const WEB_REPO = '959038055523.dkr.ecr.ap-southeast-2.amazonaws.com/blakpath/app';
const WORKER_REPO = '959038055523.dkr.ecr.ap-southeast-2.amazonaws.com/blakpath/worker';
const WEB_DIGEST = `sha256:${'a'.repeat(64)}`;
const WORKER_DIGEST = `sha256:${'b'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);

describe('continuous delivery policy', () => {
  it('pins both images by digest and records the tag with them', () => {
    const webImage = digestImageRef(WEB_REPO, WEB_DIGEST);
    const workerImage = digestImageRef(WORKER_REPO, WORKER_DIGEST);
    expect(webImage).toBe(`${WEB_REPO}@${WEB_DIGEST}`);
    expect(() => digestImageRef(`${WEB_REPO}:latest`, WEB_DIGEST)).toThrow(
      /tag or digest/,
    );
    expect(() => assertDigestImageRef(`${WEB_REPO}:7350f7c`)).toThrow(/digest/);

    assertProductionReleaseRecord({
      tag: 'v0.2.0',
      commit: COMMIT,
      webImage,
      workerImage,
      releaseGateImage: workerImage,
    });
    expect(() =>
      assertProductionReleaseRecord({
        tag: 'v0.2.0',
        commit: COMMIT,
        webImage: `${WEB_REPO}:latest`,
        workerImage,
        releaseGateImage: workerImage,
      }),
    ).toThrow(/digest/);
  });

  it('refuses long-lived AWS keys and accepts the OIDC role', () => {
    expect(findAwsAccessKeyUsage('role-to-assume: ${{ vars.AWS_CD_ROLE_ARN }}')).toEqual(
      [],
    );
    expect(
      findAwsAccessKeyUsage('aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}'),
    ).not.toEqual([]);
    assertOidcRoleArn('arn:aws:iam::959038055523:role/blakpath-github-cd');
    expect(() => assertOidcRoleArn('arn:aws:iam::959038055523:user/ci')).toThrow(
      /role ARN/,
    );
    assertEksClusterName('blakpath');
    assertTemporaryAwsCredentials(`ASIA${'X'.repeat(16)}`);
    expect(() => assertTemporaryAwsCredentials(`AKIA${'X'.repeat(16)}`)).toThrow(
      /long-lived/,
    );
    expect(() => assertTemporaryAwsCredentials(undefined)).toThrow(/missing/);
  });

  it('requires a production reviewer who is not the actor', () => {
    expect(
      productionApprovalRequired([
        {
          type: 'required_reviewers',
          prevent_self_review: true,
          reviewers: [{ type: 'User' }],
        },
      ]),
    ).toBe(true);
    expect(
      productionApprovalRequired([
        {
          type: 'required_reviewers',
          prevent_self_review: false,
          reviewers: [{ type: 'User' }],
        },
      ]),
    ).toBe(false);
    expect(() => assertProductionEnvironment({ protection_rules: [] })).toThrow(
      /reviewer/,
    );
    assertProductionEnvironment({
      protection_rules: [
        {
          type: 'required_reviewers',
          prevent_self_review: true,
          reviewers: [{ type: 'Team' }],
        },
      ],
    });
  });

  it('keeps the checked-in workflow and role template free of access keys', () => {
    const workflow = readFileSync('.github/workflows/cd.yml', 'utf8');
    assertCdWorkflow(workflow);
    expect(workflow).toContain('fetch-tags: true');
    assertOidcTemplate(readFileSync('infra/aws/github-oidc-cd.example.yaml', 'utf8'));
  });
});

describe('release notes', () => {
  it('bumps semver from conventional commits and names both digests', () => {
    expect(planRelease('0.1.0', ['fix: correct the probe'])).toMatchObject({
      version: '0.1.1',
      tag: 'v0.1.1',
      bump: 'patch',
    });
    expect(planRelease('0.1.0', ['feat: add delivery', 'fix: typo'])).toMatchObject({
      version: '0.2.0',
      tag: 'v0.2.0',
      bump: 'minor',
    });
    expect(
      planRelease('0.1.0', ['feat!: change the contract', 'chore: notes']),
    ).toMatchObject({
      version: '1.0.0',
      tag: 'v1.0.0',
      bump: 'major',
    });
    expect(() => planRelease('0.1.0', [])).toThrow(/no unreleased commits/);
  });

  it('omits commit bodies and truncates a long note', () => {
    const webImage = digestImageRef(WEB_REPO, WEB_DIGEST);
    const workerImage = digestImageRef(WORKER_REPO, WORKER_DIGEST);
    const notes = renderReleaseNotes({
      tag: 'v0.2.0',
      commit: COMMIT,
      webImage,
      workerImage,
      messages: ['feat: ship the pipeline\n\npassword=not-for-the-release'],
    });
    expect(notes).toContain('v0.2.0');
    expect(notes).toContain(webImage);
    expect(notes).toContain(workerImage);
    expect(notes).toContain('gh attestation verify');
    expect(notes).not.toContain('not-for-the-release');

    const grouped = renderReleaseNotes({
      tag: 'v0.2.0',
      commit: COMMIT,
      webImage,
      workerImage,
      messages: ['feat: one', 'feat: two'],
      subjectLimit: 1,
    });
    expect(grouped).toContain('older commits omitted');

    const truncated = renderReleaseNotes({
      tag: 'v0.2.0',
      commit: COMMIT,
      webImage,
      workerImage,
      messages: ['feat: one'],
      maxLength: 80,
    });
    expect(truncated).toContain('release notes truncated');
  });
});

describe('deploy sequence', () => {
  it('stops before rollout and rolls back after it', () => {
    expect(failureAction('release-gate')).toBe('stop');
    expect(failureAction('migrate')).toBe('stop');
    expect(failureAction('rollout')).toBe('rollback');
    expect(failureAction('smoke')).toBe('rollback');
  });

  it('renders digest-pinned gate and migrate jobs', () => {
    const image = digestImageRef(WORKER_REPO, WORKER_DIGEST);
    const gate = renderCdJob({
      step: 'release-gate',
      name: 'blakpath-release-gate-1-1',
      namespace: 'blakpath',
      image,
    });
    expect(gate).toContain(`image: ${image}`);
    expect(gate).toContain('scripts/check-production-readiness.ts');
    expect(gate).not.toContain(`${WORKER_REPO}:`);

    const migrate = renderCdJob({
      step: 'migrate',
      name: 'blakpath-migrate-1-1',
      namespace: 'blakpath-staging',
      image,
    });
    expect(migrate).toContain('src/db/migrate.ts');
    expect(migrate).toContain('namespace: blakpath-staging');
    expect(() =>
      renderCdJob({
        step: 'migrate',
        name: 'blakpath-migrate-1-1',
        namespace: 'blakpath',
        image: `${WORKER_REPO}:latest`,
      }),
    ).toThrow(/digest/);
  });

  it('refuses the production secret from the staging namespace', () => {
    assertSameAppUrl(
      'https://staging.blakpath.yumait.au',
      'https://staging.blakpath.yumait.au/',
    );
    expect(() =>
      assertSameAppUrl(
        'https://staging.blakpath.yumait.au',
        'https://blakpath.yumait.au',
      ),
    ).toThrow(/APP_URL/);
    assertRuntimeSecretPath('staging', '/blakpath/staging/runtime');
    expect(() =>
      assertRuntimeSecretPath('staging', '/blakpath/production/runtime'),
    ).toThrow(/staging/);
    expect(() =>
      assertRestorableImages('MISSING', digestImageRef(WORKER_REPO, WORKER_DIGEST)),
    ).toThrow(/previous workload/);
  });

  it('keeps staging off the production secret and evidence buckets', () => {
    const staging = readFileSync('infra/k8s/overlays/staging/kustomization.yaml', 'utf8');
    const config = readFileSync(
      'infra/k8s/overlays/staging/configmap-patch.yaml',
      'utf8',
    );
    expect(staging).toContain('namespace: blakpath-staging');
    expect(staging).toContain('/blakpath/staging/runtime');
    expect(config).toContain('https://staging.blakpath.yumait.au');
    expect(config).toContain('REPLACE_WITH_STAGING_CMK_ARN');
    expect(config).not.toContain('blakpath-prod-evidence');
    expect(
      readFileSync('infra/k8s/overlays/production/kustomization.yaml', 'utf8'),
    ).toContain('namespace: blakpath');
    const rbac = readFileSync('infra/k8s/base/cd-rbac.yaml', 'utf8');
    expect(rbac).toContain('externalsecrets');
    expect(rbac).toContain('arn:aws:iam::959038055523:role/blakpath-github-cd');
    expect(rbac).toContain("verbs: ['get']");
  });

  it('runs the gate and migration before it changes a workload', () => {
    const script = readFileSync('scripts/cd/rollout.sh', 'utf8');
    const gate = script.indexOf('# phase:release-gate');
    const migrate = script.indexOf('# phase:migrate');
    const rollout = script.indexOf('# phase:rollout');
    const smoke = script.indexOf('# phase:smoke');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(rollout);
    expect(rollout).toBeLessThan(smoke);
    expect(script).toContain('scripts/cd/rollback.sh');
    expect(readFileSync('scripts/cd/rollback.sh', 'utf8')).toContain('# phase:rollback');
  });
});

describe('smoke responses', () => {
  it('accepts a ready service and a real sign-in', async () => {
    expect(readyAccepted(200, { status: 'ready' })).toBe(true);
    expect(readyAccepted(503, { status: 'not_ready' })).toBe(false);
    expect(signInAccepted(200, { twoFactorRedirect: true }, [])).toBe(true);
    expect(
      signInAccepted(200, { user: { id: 'user' } }, [
        '__Secure-blakpath.session_token=session; Path=/; HttpOnly; Secure',
      ]),
    ).toBe(true);
    expect(signInAccepted(200, { user: { id: 'user' } }, [])).toBe(false);
    expect(signInAccepted(401, { message: 'invalid' }, [])).toBe(false);

    const sleeps: number[] = [];
    let calls = 0;
    const ready = await pollReady(
      async () => {
        calls += 1;
        return calls === 2;
      },
      {
        attempts: 3,
        delayMs: 5,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(ready).toBe(true);
    expect(sleeps).toEqual([5]);
  });
});
