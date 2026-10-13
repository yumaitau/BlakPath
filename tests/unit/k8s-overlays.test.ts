import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runCheck(args: string[]): string {
  return execFileSync(process.execPath, ['scripts/check-k8s-overlays.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('k8s overlays', () => {
  it('keeps account identifiers out of the public base and splits environments', () => {
    expect(runCheck(['--source'])).toContain('kustomize overlays ok');
  });

  it.skipIf(!kustomizeAvailable())(
    'renders staging and production without production ARNs',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'blakpath-kustomize-'));
      const overlays = [
        ['staging.yaml', 'infra/k8s/overlays/staging'],
        ['production.yaml', 'infra/k8s/overlays/production'],
        ['staging-jobs.yaml', 'infra/k8s/overlays/staging/jobs'],
        ['production-jobs.yaml', 'infra/k8s/overlays/production/jobs'],
      ] as const;
      for (const [fileName, overlay] of overlays) {
        const rendered = execFileSync('kustomize', ['build', overlay], {
          cwd: root,
          encoding: 'utf8',
        });
        writeFileSync(path.join(dir, fileName), rendered);
      }
      expect(runCheck([dir])).toContain('kustomize overlays ok');
    },
  );
});

function kustomizeAvailable(): boolean {
  const result = spawnSync('kustomize', ['version'], { encoding: 'utf8' });
  return result.status === 0;
}
