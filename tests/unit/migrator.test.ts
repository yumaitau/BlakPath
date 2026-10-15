import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLocalDatabasePush } from '@/db/db-push-guard';
import {
  GRANDFATHERED_MIGRATION_TAGS,
  lintMigrationDirectory,
  lintMigrationSql,
  MAX_LOCK_TIMEOUT_MS,
  resolveMigrationTimeouts,
  splitMigrationStatements,
  statementRunsOutsideTransaction,
} from '@/db/migrator';
import {
  APP_IMAGE_REPOSITORY,
  pinKustomizationImages,
  renderMigrateJob,
  substituteDeployTokens,
  WORKER_IMAGE_REPOSITORY,
} from '@/db/release-job';

const migrationsDir = path.resolve('src/db/migrations');
const appDigest = 'a'.repeat(64);
const workerDigest = 'b'.repeat(64);
const appImage = `${APP_IMAGE_REPOSITORY}@sha256:${appDigest}`;
const workerImage = `${WORKER_IMAGE_REPOSITORY}@sha256:${workerDigest}`;
const release = { appImage, workerImage, releaseId: 'abc1234' };

describe('migration policy', () => {
  it('grandfathers only migrations 0000-0034', () => {
    expect(GRANDFATHERED_MIGRATION_TAGS.size).toBe(35);
    for (const tag of GRANDFATHERED_MIGRATION_TAGS) {
      expect(tag).toMatch(/^00([0-2][0-9]|3[0-4])_/);
    }
  });

  it('accepts the committed journal', () => {
    expect(lintMigrationDirectory(migrationsDir)).toEqual([]);
  });

  it('rejects a copied 0016 foreign key in a new file', () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, '0016_invitation-teams.sql'),
      'utf8',
    );
    const issues = lintMigrationSql('0019_existing_fk', sql);
    expect(issues.map((issue) => issue.message).join('\n')).toMatch(/NOT VALID/);
  });

  it('accepts NOT VALID then VALIDATE, and a concurrent index', () => {
    const sql = `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS applications_status_idx ON applications (status);--> statement-breakpoint
      ALTER TABLE "applications" ADD CONSTRAINT "applications_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") NOT VALID;--> statement-breakpoint
      ALTER TABLE "applications" VALIDATE CONSTRAINT "applications_client_id_fkey";
    `;
    expect(lintMigrationSql('0019_expand', sql)).toEqual([]);
    const statements = splitMigrationStatements(sql);
    expect(statementRunsOutsideTransaction(statements[0] ?? '')).toBe(true);
    expect(statementRunsOutsideTransaction(statements[1] ?? '')).toBe(false);
    expect(statementRunsOutsideTransaction(statements[2] ?? '')).toBe(true);
  });

  it('rejects drops, renames, and a blocking index on an existing table', () => {
    const sql = `
      ALTER TABLE "applications" DROP COLUMN "legacy";
      ALTER TABLE "applications" RENAME COLUMN "status" TO "state";
      CREATE INDEX applications_status_idx ON applications (status);
    `;
    const messages = lintMigrationSql('0019_contract', sql)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/DROP COLUMN/);
    expect(messages).toMatch(/RENAME COLUMN/);
    expect(messages).toMatch(/CONCURRENTLY/);
  });

  it('treats an explicit no-transaction marker as autocommit', () => {
    expect(statementRunsOutsideTransaction('-- @no-transaction\nSELECT 1')).toBe(true);
  });
});

describe('migration timeouts', () => {
  it('caps lock_timeout under 5 seconds', () => {
    expect(MAX_LOCK_TIMEOUT_MS).toBeLessThan(5_000);
    expect(resolveMigrationTimeouts({})).toMatchObject({ lockTimeoutMs: 4_000 });
    expect(() => resolveMigrationTimeouts({ MIGRATION_LOCK_TIMEOUT_MS: '5000' })).toThrow(
      /1 to 4000/,
    );
  });
});

describe('db:push guard', () => {
  it('allows loopback and refuses other hosts', () => {
    expect(() =>
      assertLocalDatabasePush('postgres://blakpath:blakpath@localhost:5432/blakpath'),
    ).not.toThrow();
    expect(() =>
      assertLocalDatabasePush('postgres://blakpath:secret@db.internal:5432/blakpath'),
    ).toThrow(/refused for host db.internal/);
  });
});

describe('release migrate job', () => {
  const template = fs.readFileSync('infra/k8s/base/jobs/migrate.yaml', 'utf8');
  const overlay = (path: string) => fs.readFileSync(`infra/k8s/overlays/${path}`, 'utf8');

  it('pins the job to the app digest, a per-release name and a TTL', () => {
    const rendered = renderMigrateJob(template, release);
    expect(rendered).toContain('name: blakpath-migrate-abc1234');
    expect(rendered).toContain(`image: ${appImage}`);
    expect(rendered).toContain('ttlSecondsAfterFinished: 86400');
    expect(rendered).toContain('name: blakpath-migrator');
    expect(rendered).not.toContain('blakpath-runtime');
    expect(rendered).not.toContain('__IMAGE__');
    expect(rendered).not.toContain('__RELEASE_ID__');
  });

  it('rejects a floating tag', () => {
    expect(() =>
      renderMigrateJob(template, {
        ...release,
        appImage: `${APP_IMAGE_REPOSITORY}:latest`,
      }),
    ).toThrow(/digest/);
  });

  it.each(['production', 'staging'])(
    'replaces the %s overlay registry and tag tokens with the release digests',
    (environment) => {
      for (const file of ['kustomization.yaml', 'release-check/kustomization.yaml']) {
        const pinned = pinKustomizationImages(overlay(`${environment}/${file}`), release);
        expect(pinned).toContain(`newName: ${APP_IMAGE_REPOSITORY}\n`);
        expect(pinned).toContain(`newName: ${WORKER_IMAGE_REPOSITORY}\n`);
        expect(pinned).toContain(`digest: sha256:${appDigest}`);
        expect(pinned).toContain(`digest: sha256:${workerDigest}`);
        expect(pinned).not.toMatch(/newTag|__ECR_REGISTRY__|__IMAGE_TAG__/);
      }
    },
  );

  const deployValues = {
    AWS_ACCOUNT_ID: '123456789012',
    S3_BUCKET_EVIDENCE: 'example-evidence',
    S3_BUCKET_QUARANTINE: 'example-quarantine',
    S3_BUCKET_AUDIT_ANCHORS: 'example-anchors',
    S3_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-2:123456789012:key/example',
  };

  it('fills the overlay tokens from private deploy values', () => {
    const config = overlay('production/configmap-patch.yaml');
    const filled = substituteDeployTokens(config, 'production', deployValues);
    expect(filled).toContain('S3_BUCKET_EVIDENCE: example-evidence');
    expect(filled).toContain('S3_BUCKET_AUDIT_ANCHORS: example-anchors');
    expect(filled).toContain(
      'EMAIL_SNS_TOPIC_ARN: arn:aws:sns:ap-southeast-2:123456789012:blakpath-email-events',
    );
    expect(filled).not.toMatch(/__[A-Z0-9_]+__/);
    const account = substituteDeployTokens(
      overlay('staging/serviceaccount-patch.yaml'),
      'staging',
      deployValues,
    );
    expect(account).toContain(
      'arn:aws:iam::123456789012:role/blakpath-staging-external-secrets',
    );
  });

  it('refuses a missing value, a bad account id and another environment token', () => {
    const config = overlay('production/configmap-patch.yaml');
    expect(() =>
      substituteDeployTokens(config, 'production', {
        ...deployValues,
        S3_BUCKET_AUDIT_ANCHORS: undefined,
      }),
    ).toThrow(/S3_BUCKET_AUDIT_ANCHORS is required/);
    expect(() =>
      substituteDeployTokens(config, 'production', {
        ...deployValues,
        AWS_ACCOUNT_ID: '1234',
      }),
    ).toThrow(/12-digit/);
    expect(() =>
      substituteDeployTokens(config, 'production', {
        ...deployValues,
        S3_BUCKET_EVIDENCE: 'evil\nkey: value',
      }),
    ).toThrow(/characters/);
    expect(() => substituteDeployTokens(config, 'staging', deployValues)).toThrow(
      /unresolved deploy token __PRODUCTION_/,
    );
  });

  it('deploys through one script: gate, then migrate, then rollout', () => {
    const script = fs.readFileSync('scripts/eks-deploy.sh', 'utf8');
    const gate = script.indexOf('wait_for_job "$gate_job"');
    const migrate = script.indexOf('wait_for_job "$migrate_job"');
    const rollout = script.indexOf('-f - <<<"$rendered"');
    expect(gate).toBeGreaterThan(0);
    expect(migrate).toBeGreaterThan(gate);
    expect(rollout).toBeGreaterThan(migrate);
    expect(fs.readFileSync('.github/workflows/deploy.yml', 'utf8')).toContain(
      'bash scripts/eks-deploy.sh',
    );
    expect(fs.existsSync('scripts/cd-release.sh')).toBe(false);
  });
});
