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
  const template = fs.readFileSync('infra/k8s/jobs/migrate.yaml', 'utf8');
  const kustomization = fs.readFileSync('infra/k8s/kustomization.yaml', 'utf8');

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

  it('replaces kustomize tags with the release digests', () => {
    const pinned = pinKustomizationImages(kustomization, release);
    expect(pinned).toContain(`digest: sha256:${appDigest}`);
    expect(pinned).toContain(`digest: sha256:${workerDigest}`);
    expect(pinned).not.toMatch(/newTag/);
  });

  it('pins the release gate to the same digests', () => {
    const gate = fs.readFileSync('infra/k8s/release-check/kustomization.yaml', 'utf8');
    const pinned = pinKustomizationImages(gate, release);
    expect(pinned).toContain(`digest: sha256:${appDigest}`);
    expect(pinned).toContain(`digest: sha256:${workerDigest}`);
    expect(pinned).not.toMatch(/newTag/);
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
