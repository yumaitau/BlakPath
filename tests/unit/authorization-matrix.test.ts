import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, type Permission } from '@/lib/permissions/catalog';
import {
  ROUTE_MATRIX,
  ROLE_SESSION_FIXTURES,
  UNROUTED_PERMISSIONS,
  accessLabel,
  denyActorFor,
  denyStatusesFor,
  isMutating,
  roleSatisfies,
  routeFile,
  routeKey,
} from '@/lib/permissions/route-matrix';
import { SYSTEM_ROLE_SLUGS, permissionsForRole } from '@/lib/permissions/roles';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function discoverHandlers(): string[] {
  const apiRoot = path.join(ROOT, 'src/app/api');
  const found: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== 'route.ts') continue;
      const text = readFileSync(full, 'utf8');
      const methods = new Set<string>();
      for (const match of text.matchAll(
        /export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g,
      )) {
        if (match[1]) methods.add(match[1]);
      }
      for (const match of text.matchAll(/export const \{([^}]+)\}/g)) {
        const list = match[1] ?? '';
        for (const name of list.split(',')) {
          const method = name.trim();
          if ((HTTP_METHODS as readonly string[]).includes(method)) methods.add(method);
        }
      }
      const rel = path.relative(path.join(ROOT, 'src/app'), full).replaceAll('\\', '/');
      const apiPath = `/${rel.replace(/\/route\.ts$/, '')}`;
      for (const method of methods) found.push(`${method} ${apiPath}`);
    }
  }

  walk(apiRoot);
  return found.sort();
}

function splitRow(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function parseRoleGrid(markdown: string): Map<string, Set<string>> {
  const lines = markdown.split('\n');
  const headerIdx = lines.findIndex(
    (line) =>
      line.startsWith('|') && SYSTEM_ROLE_SLUGS.every((slug) => line.includes(slug)),
  );
  expect(headerIdx, 'role grid header').toBeGreaterThan(-1);
  const header = splitRow(lines[headerIdx] ?? '');
  const roleIndex = new Map<string, number>();
  header.forEach((cell, index) => {
    if ((SYSTEM_ROLE_SLUGS as readonly string[]).includes(cell))
      roleIndex.set(cell, index);
  });
  expect(roleIndex.size).toBe(SYSTEM_ROLE_SLUGS.length);

  const grants = new Map<string, Set<string>>();
  for (let i = headerIdx + 2; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('|')) break;
    const cells = splitRow(line);
    const key = (cells[0] ?? '').replaceAll('`', '').trim();
    if (!key) continue;
    const holders = new Set<string>();
    for (const [slug, index] of roleIndex) {
      if ((cells[index] ?? '').trim() === '✓') holders.add(slug);
    }
    grants.set(key, holders);
  }
  return grants;
}

describe('authorisation matrix drift', () => {
  it('lists every API handler once, and no invented handlers', () => {
    const discovered = discoverHandlers();
    const listed = ROUTE_MATRIX.map(routeKey).sort();
    expect(listed).toEqual(discovered);
    expect(new Set(listed).size).toBe(listed.length);
    for (const entry of ROUTE_MATRIX) {
      expect(routeFile(entry.path).endsWith('/route.ts')).toBe(true);
    }
  });

  it('accounts for every catalogue key exactly once', () => {
    const routed = new Set<Permission>();
    for (const entry of ROUTE_MATRIX) {
      if (entry.gate.kind !== 'any') continue;
      for (const key of entry.gate.permissions) routed.add(key);
    }
    const unrouted = Object.keys(
      UNROUTED_PERMISSIONS,
    ) as (keyof typeof UNROUTED_PERMISSIONS)[];
    for (const key of unrouted) {
      expect(routed.has(key), `${key} is both routed and unrouted`).toBe(false);
      expect(ALL_PERMISSIONS).toContain(key);
      expect(UNROUTED_PERMISSIONS[key].length).toBeGreaterThan(0);
    }
    expect([...routed, ...unrouted].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('gives every mutating route a non-success deny case', () => {
    for (const entry of ROUTE_MATRIX) {
      if (!isMutating(entry)) continue;
      expect(entry.skipProbe, routeKey(entry)).not.toBe(true);
      const actor = denyActorFor(entry);
      expect(actor, routeKey(entry)).not.toBeNull();
      const statuses = denyStatusesFor(entry);
      expect(statuses.length, routeKey(entry)).toBeGreaterThan(0);
      expect(
        statuses.every((status) => status >= 400),
        routeKey(entry),
      ).toBe(true);
      if (actor?.type === 'role' && entry.gate.kind === 'any') {
        expect(roleSatisfies(actor.slug, entry.gate), routeKey(entry)).toBe(false);
      }
    }
  });

  it('only allow-probes a role that satisfies the gate', () => {
    for (const entry of ROUTE_MATRIX) {
      if (!entry.allowProbe) continue;
      if (entry.gate.kind === 'public') continue;
      const role = entry.allowRole;
      expect(role, routeKey(entry)).toBeDefined();
      if (role) expect(roleSatisfies(role, entry.gate)).toBe(true);
    }
  });

  it('has a session fixture for every system role', () => {
    expect(Object.keys(ROLE_SESSION_FIXTURES).sort()).toEqual(
      [...SYSTEM_ROLE_SLUGS].sort(),
    );
    for (const slug of SYSTEM_ROLE_SLUGS) {
      expect(ROLE_SESSION_FIXTURES[slug].isPlatformOperator).toBe(
        slug === 'platform-operator',
      );
    }
  });

  it('matches the published role grid and route table', () => {
    const markdown = readFileSync(
      path.join(ROOT, 'docs/authorization-matrix.md'),
      'utf8',
    );
    const grants = parseRoleGrid(markdown);

    for (const key of ALL_PERMISSIONS) {
      expect(markdown).toContain(`\`${key}\``);
      const holders = grants.get(key);
      expect(holders, key).toBeDefined();
      for (const slug of SYSTEM_ROLE_SLUGS) {
        const expected = permissionsForRole(slug).includes(key);
        expect(holders?.has(slug) ?? false, `${slug} ${key}`).toBe(expected);
      }
    }
    expect(grants.size).toBe(ALL_PERMISSIONS.length);

    const mentioned = new Set<string>();
    for (const line of markdown.split('\n')) {
      const match = line.match(/\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/);
      if (match?.[1] && match[2]) mentioned.add(`${match[1]} ${match[2]}`);
    }
    for (const entry of ROUTE_MATRIX) {
      expect(mentioned.has(routeKey(entry)), routeKey(entry)).toBe(true);
    }

    expect(markdown).not.toContain('`audit:read`');
    expect(markdown).not.toContain('`audit:verify`');
    expect(markdown).toMatch(/never determines Aboriginality/i);
  });

  it('does not describe a permission that scores or determines a person', () => {
    for (const key of ALL_PERMISSIONS) {
      expect(key).not.toMatch(/score|rank|predict|auto-approve|auto-reject|determine/i);
    }
    for (const entry of ROUTE_MATRIX) {
      expect(accessLabel(entry).length).toBeGreaterThan(0);
    }
  });
});
