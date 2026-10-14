import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { domainFunctionId, listDomainFunctions } from '../helpers/domain-functions';

function pinnedCases(): string[] {
  const raw = readFileSync(
    new URL('../integration/cross-tenant-cases.json', import.meta.url),
    'utf8',
  );
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('cross-tenant-cases.json must be a string array');
  }
  return parsed as string[];
}

describe('cross-tenant coverage', () => {
  it('pins one case for every exported domain function', () => {
    const found = listDomainFunctions().map(domainFunctionId);
    const pinned = pinnedCases();
    expect(new Set(found).size).toBe(found.length);
    expect(found.length).toBe(pinned.length);
    expect(found).toEqual(pinned);
  });
});
