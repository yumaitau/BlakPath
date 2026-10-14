import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Multi-arch manifest digest. CI, Compose, and the restore drill must match. */
const OBJECT_STORAGE_IMAGE =
  'chainguard/minio@sha256:dc455cdd4db6e390b1b26514f15ff37681a777bf8dab41aac445a0259f751e56';

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('object storage image pin', () => {
  it('uses one digest in CI, Compose, and the restore drill', () => {
    const ci = read('.github/workflows/ci.yml');
    const compose = read('docker-compose.yml');
    const drill = read('scripts/verify-restore-drill.sh');

    expect(ci).not.toContain(':latest');
    expect(ci).not.toMatch(/minio\/m(?:inio|c):/);
    expect(compose).not.toMatch(/minio\/m(?:inio|c):/);
    expect(drill).not.toMatch(/minio\/m(?:inio|c):/);

    expect(ci.match(new RegExp(OBJECT_STORAGE_IMAGE, 'g'))).toHaveLength(2);
    expect(compose.match(new RegExp(OBJECT_STORAGE_IMAGE, 'g'))).toHaveLength(2);
    expect(drill).toContain(OBJECT_STORAGE_IMAGE);
  });
});
