import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('domain coverage', () => {
  it('imports every src/domains directory', async () => {
    const root = join(process.cwd(), 'src/domains');
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(dirs.length).toBeGreaterThan(0);

    for (const dir of dirs) {
      const specifier = existsSync(join(root, dir, 'index.ts'))
        ? `@/domains/${dir}`
        : `@/domains/${dir}/service`;
      const loaded = (await import(specifier)) as Record<string, unknown>;
      if (Object.keys(loaded).length === 0) {
        throw new Error(`${dir} exported nothing from ${specifier}`);
      }
    }
  }, 30_000);
});
