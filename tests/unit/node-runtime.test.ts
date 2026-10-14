import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function pinnedVersion(dockerfile: string, name: string): string {
  const match = dockerfile.match(/^ARG NODE_VERSION=(\d+\.\d+\.\d+)\s*$/m);
  expect(match, `${name} pins NODE_VERSION`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Node runtime pin', () => {
  const production = read('Dockerfile');
  const development = read('Dockerfile.dev');
  const version = pinnedVersion(production, 'Dockerfile');

  it('pins production and development Node images by digest on the same release', () => {
    expect(Number(version.split('.')[0])).toBeGreaterThanOrEqual(22);
    expect(pinnedVersion(development, 'Dockerfile.dev')).toBe(version);

    const images = [
      ['Dockerfile', production, 'alpine'],
      ['Dockerfile.dev', development, 'slim'],
    ] as const;

    for (const [name, dockerfile, variant] of images) {
      const fromLines = dockerfile
        .split('\n')
        .filter((line) => line.startsWith('FROM node:'));
      expect(fromLines.length, name).toBeGreaterThan(0);
      for (const line of fromLines) {
        expect(line, name).toContain(`node:\${NODE_VERSION}-${variant}@sha256:`);
        expect(line, name).toMatch(/@sha256:[a-f0-9]{64}(?:\s|$)/);
      }
      const digests = fromLines.map((line) => line.match(/@sha256:[a-f0-9]{64}/)?.[0]);
      expect(new Set(digests).size, name).toBe(1);
    }
  });

  it('keeps CI, nvm, engines, and @types/node on that major', () => {
    expect(read('.nvmrc').trim()).toBe(version);
    expect(read('.github/workflows/ci.yml')).toContain(`NODE_VERSION: '${version}'`);
    expect(read('.github/workflows/security.yml')).toContain(
      `NODE_VERSION: '${version}'`,
    );

    const pkg = JSON.parse(read('package.json')) as {
      engines: { node: string };
      devDependencies: { '@types/node': string };
    };
    expect(pkg.engines.node).toBe(`>=${version}`);
    expect(pkg.devDependencies['@types/node']).toMatch(/^\^24\./);
  });
});
