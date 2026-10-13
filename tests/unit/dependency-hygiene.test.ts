import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

type Review = {
  latestMajor: number;
  /** Required when latestMajor is more than one ahead of the declared major. */
  trackingIssue?: string;
};

/**
 * Production dependency majors reviewed 2026-10-13.
 * `latestMajor` is the semver major of the newest release that day.
 * For 0.x packages the major is 0; a later 0.y line is not a second major.
 */
const productionReview: Record<string, Review> = {
  '@aws-sdk/client-kms': { latestMajor: 3 },
  '@aws-sdk/client-s3': { latestMajor: 3 },
  '@aws-sdk/client-sesv2': { latestMajor: 3 },
  '@aws-sdk/s3-request-presigner': { latestMajor: 3 },
  '@better-auth/passkey': { latestMajor: 1 },
  '@dnd-kit/core': { latestMajor: 6 },
  '@dnd-kit/sortable': { latestMajor: 10 },
  '@dnd-kit/utilities': { latestMajor: 3 },
  '@node-rs/argon2': { latestMajor: 2 },
  '@opentelemetry/api': { latestMajor: 1 },
  '@opentelemetry/auto-instrumentations-node': { latestMajor: 0, trackingIssue: '30' },
  '@opentelemetry/exporter-trace-otlp-http': { latestMajor: 0, trackingIssue: '30' },
  '@opentelemetry/sdk-node': { latestMajor: 0, trackingIssue: '30' },
  '@radix-ui/react-dropdown-menu': { latestMajor: 2 },
  '@radix-ui/react-label': { latestMajor: 2 },
  '@radix-ui/react-slot': { latestMajor: 1 },
  'better-auth': { latestMajor: 1 },
  bullmq: { latestMajor: 6 },
  'class-variance-authority': { latestMajor: 0 },
  clsx: { latestMajor: 2 },
  'drizzle-orm': { latestMajor: 0 },
  'file-type': { latestMajor: 22 },
  ioredis: { latestMajor: 6 },
  'lucide-react': { latestMajor: 1 },
  nanoid: { latestMajor: 6 },
  next: { latestMajor: 16 },
  nodemailer: { latestMajor: 10 },
  'pdf-lib': { latestMajor: 1 },
  pino: { latestMajor: 10 },
  postgres: { latestMajor: 3 },
  react: { latestMajor: 19 },
  'react-dom': { latestMajor: 19 },
  'tailwind-merge': { latestMajor: 3 },
  uuidv7: { latestMajor: 1 },
  zod: { latestMajor: 4 },
};

const removedDependencies = [
  'react-hook-form',
  '@hookform/resolvers',
  '@radix-ui/react-dialog',
  '@radix-ui/react-tabs',
  '@radix-ui/react-toast',
] as const;

/** Component-test libraries kept until issue 75. */
const heldUntilCoverage = ['@testing-library/react', 'jsdom'] as const;

const skipDirs = new Set([
  'node_modules',
  '.git',
  '.next',
  'coverage',
  'dist',
  'playwright-report',
  'test-results',
]);

const textNames = new Set(['Dockerfile', 'Dockerfile.dev']);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as unknown;
}

function majorsBehind(declared: string, latestMajor: number): number {
  const match = declared.match(/\d+/);
  if (!match?.[0]) {
    throw new Error(`No major in dependency range ${declared}`);
  }
  return latestMajor - Number(match[0]);
}

function isTextFile(name: string): boolean {
  if (textNames.has(name)) return true;
  return /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|sh|toml|example)$/.test(name);
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path, out);
      continue;
    }
    if (info.isFile() && isTextFile(entry)) out.push(path);
  }
}

describe('dependency hygiene', () => {
  it('counts only the semver major', () => {
    expect(majorsBehind('^0.54.0', 0)).toBe(0);
    expect(majorsBehind('^5.21.0', 6)).toBe(1);
    expect(majorsBehind('^19.5.0', 22)).toBe(3);
  });

  it('caps every override target to a caret range', () => {
    const pkg = readJson('package.json') as {
      pnpm: { overrides: Record<string, string> };
    };
    const overrides = pkg.pnpm.overrides;
    expect(Object.keys(overrides).some((key) => key.startsWith('next@'))).toBe(false);
    expect(Object.keys(overrides).filter((key) => key.startsWith('postcss@'))).toEqual([
      'postcss@<8.5.18',
    ]);
    for (const value of Object.values(overrides)) {
      expect(value).toMatch(/^\^/);
      expect(value.startsWith('>=')).toBe(false);
    }
  });

  it('documents every ignored advisory with issue 30 and the review date', () => {
    const pkg = readJson('package.json') as {
      pnpm: { auditConfig: { ignoreGhsas: string[] } };
    };
    const doc = readFileSync(join(root, 'docs/supply-chain.md'), 'utf8');
    expect(pkg.pnpm.auditConfig.ignoreGhsas).toEqual(['GHSA-q7rr-3cgh-j5r3']);
    expect(doc).toContain('GHSA-q7rr-3cgh-j5r3');
    expect(doc).toContain('#30');
    expect(doc).toContain('2026-10-13');
    expect(doc).toContain('Remove when');
  });

  it('keeps production dependencies within one major of the review, or tracks them', () => {
    const pkg = readJson('package.json') as { dependencies: Record<string, string> };
    const doc = readFileSync(join(root, 'docs/supply-chain.md'), 'utf8');
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      Object.keys(productionReview).sort(),
    );

    for (const name of removedDependencies) {
      expect(pkg.dependencies[name]).toBeUndefined();
    }

    for (const [name, spec] of Object.entries(pkg.dependencies)) {
      const review = productionReview[name];
      expect(review, name).toBeDefined();
      if (!review) continue;
      const behind = majorsBehind(spec, review.latestMajor);
      expect(behind, name).toBeGreaterThanOrEqual(0);
      if (behind > 1) {
        expect(review.trackingIssue, name).toBeTruthy();
      }
      if (review.trackingIssue) {
        expect(doc).toContain(`#${review.trackingIssue}`);
      }
    }
  });

  it('holds component-test libraries until issue 75 and documents every ignore', () => {
    const pkg = readJson('package.json') as { devDependencies: Record<string, string> };
    const knip = readJson('knip.json') as { ignoreDependencies: string[] };
    const depcheck = readJson('.depcheckrc.json') as { ignores: string[] };
    const doc = readFileSync(join(root, 'docs/supply-chain.md'), 'utf8');

    for (const name of heldUntilCoverage) {
      expect(pkg.devDependencies[name], name).toBeTruthy();
    }
    expect(knip.ignoreDependencies).toContain('@testing-library/react');
    expect(depcheck.ignores).toContain('@testing-library/react');
    expect(doc).toContain('#75');
    expect(doc).toContain('pino-pretty');
    for (const name of [...knip.ignoreDependencies, ...depcheck.ignores]) {
      expect(doc, name).toContain(name);
    }
  });

  it('pins every GitHub Action use to a 40-character SHA', () => {
    const workflowDir = join(root, '.github/workflows');
    const workflows = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));
    expect(workflows.length).toBeGreaterThan(0);

    for (const name of workflows) {
      const text = readFileSync(join(workflowDir, name), 'utf8');
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)];
      expect(uses.length, name).toBeGreaterThan(0);
      for (const match of uses) {
        const ref = match[1];
        if (!ref || ref.startsWith('./')) continue;
        expect(ref, `${name}: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it('does not reference a floating latest image tag', () => {
    const files: string[] = [];
    walk(root, files);
    const floating = ':' + 'latest';
    const hits = files.filter((path) => readFileSync(path, 'utf8').includes(floating));
    expect(hits.map((path) => relative(root, path))).toEqual([]);
  });
});
