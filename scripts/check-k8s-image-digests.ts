import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  auditK8sDirectory,
  auditRenderedImages,
  kustomizationRoots,
} from './k8s-image-digests';

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function renderManifest(bin: string, directory: string): string {
  const args =
    path.basename(bin) === 'kustomize' ? ['build', directory] : ['kustomize', directory];
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`failed to run ${bin}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `${bin} exited ${result.status ?? 'unknown'}`,
    );
  }
  return result.stdout;
}

const root = argument('--root') ?? 'infra/k8s';
const render = process.argv.includes('--render');
const audited = auditK8sDirectory(root);
const issues = audited.issues;

if (render) {
  const bin = argument('--kustomize') ?? 'kubectl';
  try {
    // Root plus standalone overlays (e.g. jobs/invite-admin), so every
    // container under root is rendered through the shared pin.
    const rendered = kustomizationRoots(root)
      .map((directory) => renderManifest(bin, directory))
      .join('\n---\n');
    issues.push(...auditRenderedImages(rendered, audited.containers));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`kustomize render failed: ${message}`);
  }
}

if (issues.length > 0) {
  console.error('k8s image digest check failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.info('k8s image digests OK');
}
