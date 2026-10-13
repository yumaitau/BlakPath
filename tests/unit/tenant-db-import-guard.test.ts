import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

async function restricted(filePath: string, source: string): Promise<number> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const results = await eslint.lintText(source, { filePath });
  return (results[0]?.messages ?? []).filter(
    (message) => message.ruleId === 'no-restricted-imports',
  ).length;
}

describe('raw database client import guard', () => {
  const client = `import { db } from '@/db/client';\nexport const handle = db;\n`;
  const platform = `import { platformDb } from '@/db/platform-db';\nexport const handle = platformDb;\n`;

  it('rejects a new raw-client import in src/domains', async () => {
    expect(await restricted('src/domains/example/service.ts', client)).toBeGreaterThan(0);
    expect(await restricted('src/domains/example/service.ts', platform)).toBeGreaterThan(
      0,
    );
  });

  it('keeps the vetted allowlists on a single handle', async () => {
    expect(await restricted('src/domains/audit/service.ts', client)).toBe(0);
    expect(await restricted('src/domains/audit/service.ts', platform)).toBeGreaterThan(0);
    expect(await restricted('src/domains/forms/service.ts', platform)).toBe(0);
    expect(await restricted('src/domains/forms/service.ts', client)).toBeGreaterThan(0);
  });
});
