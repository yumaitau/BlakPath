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

/** A client-side kustomize renderer: `kustomize build` or `kubectl kustomize`. */
function renderer(): string[] | null {
  if (spawnSync('kustomize', ['version'], { encoding: 'utf8' }).status === 0) {
    return ['kustomize', 'build'];
  }
  if (spawnSync('kubectl', ['version', '--client'], { encoding: 'utf8' }).status === 0) {
    return ['kubectl', 'kustomize'];
  }
  return null;
}

const render = renderer();

describe('k8s overlays', () => {
  it('keeps account identifiers out of the public base and splits environments', () => {
    expect(runCheck(['--source'])).toContain('kustomize overlays ok');
  });

  it.skipIf(!render)('renders staging and production without production ARNs', () => {
    const [command = '', ...prefix] = render ?? [];
    const dir = mkdtempSync(path.join(tmpdir(), 'blakpath-kustomize-'));
    for (const env of ['staging', 'production']) {
      for (const [suffix, sub] of [
        ['', ''],
        ['-jobs', '/jobs'],
        ['-release-check', '/release-check'],
      ] as const) {
        const rendered = execFileSync(
          command,
          [...prefix, `infra/k8s/overlays/${env}${sub}`],
          { cwd: root, encoding: 'utf8' },
        );
        writeFileSync(path.join(dir, `${env}${suffix}.yaml`), rendered);
      }
    }
    expect(runCheck([dir])).toContain('kustomize overlays ok');
  });
});
