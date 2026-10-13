import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  ROUTE_MATRIX,
  ROLE_SESSION_FIXTURES,
  denyActorFor,
  denyStatusesFor,
  routeKey,
  type DenyActor,
  type RouteMatrixEntry,
} from '@/lib/permissions/route-matrix';
import { SYSTEM_ROLE_SLUGS, type SystemRoleSlug } from '@/lib/permissions/roles';

/**
 * Role × route checks against a migrated Postgres database.
 * Skipped unless RUN_INTEGRATION=true (CI sets that after migrate + seed).
 * Session cookies are not signed: requireSession is stubbed, and tenant
 * resolution still reads membership and role grants from the database.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

const FAKE_ID = '00000000-0000-4000-8000-000000000099';

interface FixtureUser {
  id: string;
  email: string;
  name: string;
}

interface FixtureSession {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    token: string;
    createdAt: Date;
    updatedAt: Date;
    activeOrganisationId: string;
  };
}

const sessionBox = vi.hoisted(() => ({
  current: null as FixtureSession | null,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: () => undefined,
    getAll: () => [],
    set: () => undefined,
    delete: () => undefined,
  }),
}));

class MatrixUnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  readonly status = 401;
  constructor(message = 'Authentication is required for this action.') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual('@/lib/auth/session');
  return {
    ...actual,
    UnauthenticatedError: MatrixUnauthenticatedError,
    getServerSession: async () => sessionBox.current,
    requireSession: async () => {
      if (!sessionBox.current) throw new MatrixUnauthenticatedError();
      return sessionBox.current;
    },
    requireRecentAuth: async () => {
      if (!sessionBox.current) throw new MatrixUnauthenticatedError();
      return sessionBox.current;
    },
  };
});

const routeModules = import.meta.glob('../../src/app/api/**/route.ts');

function sessionFor(user: FixtureUser, organisationId: string): FixtureSession {
  const now = new Date();
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: randomUUID(),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      token: `matrix-${user.id}`,
      createdAt: now,
      updatedAt: now,
      activeOrganisationId: organisationId,
    },
  };
}

function substitute(
  value: unknown,
  userId: string | null,
  organisationId: string,
): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('{{org}}', organisationId)
      .replaceAll('{{user}}', userId ?? '');
  }
  if (Array.isArray(value))
    return value.map((item) => substitute(item, userId, organisationId));
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = substitute(item, userId, organisationId);
    }
    if (typeof next.slug === 'string') next.slug = `mx-${randomUUID().slice(0, 8)}`;
    return next;
  }
  return value;
}

function requestUrl(
  entry: RouteMatrixEntry,
  userId: string | null,
  organisationId: string,
): string {
  const raw = entry.requestPath ?? entry.path;
  const path = raw
    .replaceAll('[token]', 'not-a-real-token')
    .replaceAll('[...all]', 'sign-in/email')
    .replaceAll(/\[[^\]]+\]/g, FAKE_ID);
  const search = entry.search ? substitute(entry.search, userId, organisationId) : '';
  const query = typeof search === 'string' && search.length > 0 ? `?${search}` : '';
  return `http://localhost${path}${query}`;
}

function paramsFor(path: string): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  for (const match of path.matchAll(/\[(\.\.\.)?([^\]]+)\]/g)) {
    const name = match[2];
    if (!name) continue;
    if (match[1]) params[name] = ['sign-in', 'email'];
    else if (name === 'token') params[name] = 'not-a-real-token';
    else params[name] = FAKE_ID;
  }
  return params;
}

function buildRequest(
  entry: RouteMatrixEntry,
  userId: string | null,
  organisationId: string,
): NextRequest {
  const url = requestUrl(entry, userId, organisationId);
  if (entry.rawBody !== undefined) {
    return new NextRequest(url, {
      method: entry.method,
      body: entry.rawBody,
      headers: { 'content-type': 'text/calendar' },
    });
  }
  const sendJson = entry.method !== 'GET' && entry.method !== 'DELETE';
  if (!sendJson) return new NextRequest(url, { method: entry.method });
  const payload =
    entry.body === undefined ? {} : substitute(entry.body, userId, organisationId);
  return new NextRequest(url, {
    method: entry.method,
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
  });
}

async function invoke(
  entry: RouteMatrixEntry,
  userId: string | null,
  organisationId: string,
): Promise<Response> {
  const suffix = `src/app${entry.path}/route.ts`;
  const key = Object.keys(routeModules).find((candidate) => candidate.endsWith(suffix));
  const load = key ? routeModules[key] : undefined;
  if (!load) throw new Error(`No route module for ${entry.path}`);
  const loaded = await load();
  const handler = (loaded as Record<string, unknown>)[entry.method];
  if (typeof handler !== 'function')
    throw new Error(`No ${entry.method} on ${entry.path}`);
  const response = await handler(buildRequest(entry, userId, organisationId), {
    params: Promise.resolve(paramsFor(entry.path)),
  });
  if (!(response instanceof Response)) {
    throw new Error(`${routeKey(entry)} returned no Response`);
  }
  return response;
}

integration('authorisation matrix', () => {
  const users = new Map<SystemRoleSlug, FixtureUser>();
  let revoked: FixtureUser | undefined;
  let organisationId = '';
  let closeDatabase: (() => Promise<unknown>) | undefined;

  function userIdFor(actor: DenyActor | null, allowRole?: SystemRoleSlug): string | null {
    if (allowRole) return users.get(allowRole)?.id ?? null;
    if (!actor || actor.type === 'anonymous' || actor.type === 'uncredentialed')
      return null;
    if (actor.type === 'revoked') return revoked?.id ?? null;
    return users.get(actor.slug)?.id ?? null;
  }

  function applyActor(actor: DenyActor | null): void {
    if (!actor || actor.type === 'anonymous' || actor.type === 'uncredentialed') {
      sessionBox.current = null;
      return;
    }
    const user = actor.type === 'revoked' ? revoked : users.get(actor.slug);
    if (!user) throw new Error('Missing fixture user');
    sessionBox.current = sessionFor(user, organisationId);
  }

  beforeAll(async () => {
    const [{ db, sqlClient }, schema, catalog, roles, drizzle, { uuidv7 }] =
      await Promise.all([
        import('@/db/client'),
        import('@/db/schema'),
        import('@/lib/permissions/catalog'),
        import('@/lib/permissions/roles'),
        import('drizzle-orm'),
        import('uuidv7'),
      ]);
    closeDatabase = () => sqlClient.end({ timeout: 5 });

    await db
      .insert(schema.permissions)
      .values(
        catalog.PERMISSION_SEED.map((def) => ({
          key: def.key,
          description: def.description,
          category: def.category,
        })),
      )
      .onConflictDoNothing({ target: schema.permissions.key });

    const existingRoles = await db
      .select({ id: schema.roles.id, slug: schema.roles.slug })
      .from(schema.roles)
      .where(drizzle.isNull(schema.roles.organisationId));
    const roleIdBySlug = new Map(existingRoles.map((row) => [row.slug, row.id]));
    for (const template of roles.SYSTEM_ROLE_SEED) {
      if (roleIdBySlug.has(template.slug)) continue;
      const id = uuidv7();
      await db.insert(schema.roles).values({
        id,
        organisationId: null,
        slug: template.slug,
        name: template.name,
        description: template.description,
        isSystem: true,
      });
      roleIdBySlug.set(template.slug, id);
    }
    for (const template of roles.SYSTEM_ROLE_SEED) {
      const roleId = roleIdBySlug.get(template.slug);
      if (!roleId) throw new Error(`Missing system role ${template.slug}`);
      for (const key of template.permissions) {
        await db
          .insert(schema.rolePermissions)
          .values({ roleId, permissionKey: key })
          .onConflictDoNothing({
            target: [schema.rolePermissions.roleId, schema.rolePermissions.permissionKey],
          });
      }
    }

    const suffix = randomUUID().slice(0, 8);
    organisationId = uuidv7();
    await db.insert(schema.organisations).values({
      id: organisationId,
      legalName: 'Authorisation Matrix Organisation',
      slug: `matrix-${suffix}`,
      status: 'active',
    });

    const created: FixtureUser[] = [];
    for (const slug of SYSTEM_ROLE_SLUGS) {
      const user: FixtureUser = {
        id: uuidv7(),
        email: `matrix-${slug}-${suffix}@example.test`,
        name: `Matrix ${slug}`,
      };
      users.set(slug, user);
      created.push(user);
    }
    revoked = {
      id: uuidv7(),
      email: `matrix-revoked-${suffix}@example.test`,
      name: 'Matrix revoked',
    };
    created.push(revoked);

    function slugFor(userId: string): SystemRoleSlug | null {
      for (const [slug, fixture] of users) {
        if (fixture.id === userId) return slug;
      }
      return null;
    }

    await db.insert(schema.users).values(
      created.map((user) => {
        const slug = slugFor(user.id);
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: true,
          isPlatformOperator: slug
            ? ROLE_SESSION_FIXTURES[slug].isPlatformOperator
            : false,
        };
      }),
    );

    const membershipRows = created.map((user) => ({
      id: uuidv7(),
      organisationId,
      userId: user.id,
      status: user.id === revoked?.id ? ('revoked' as const) : ('active' as const),
    }));
    await db.insert(schema.memberships).values(membershipRows);
    await db.insert(schema.membershipRoles).values(
      membershipRows.map((membership) => {
        const slug = slugFor(membership.userId) ?? 'organisation-admin';
        const roleId = roleIdBySlug.get(slug);
        if (!roleId) throw new Error(`Missing role ${slug}`);
        return { id: uuidv7(), membershipId: membership.id, roleId };
      }),
    );

    for (const slug of SYSTEM_ROLE_SLUGS) {
      expect(users.get(slug)?.id).toBeTruthy();
    }
  }, 120_000);

  afterAll(async () => {
    if (!closeDatabase || !organisationId) return;
    const [{ db }, schema, drizzle] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('drizzle-orm'),
    ]);
    const userIds = [...users.values(), ...(revoked ? [revoked] : [])].map(
      (user) => user.id,
    );
    await db
      .delete(schema.organisations)
      .where(drizzle.eq(schema.organisations.id, organisationId));
    if (userIds.length > 0) {
      await db.delete(schema.users).where(drizzle.inArray(schema.users.id, userIds));
    }
    await closeDatabase();
  });

  it.each(ROUTE_MATRIX.filter((entry) => !entry.skipProbe))(
    '$method $path',
    async (entry) => {
      const actor = denyActorFor(entry);
      if (actor) {
        applyActor(actor);
        const denied = await invoke(entry, userIdFor(actor), organisationId);
        const snippet = (await denied.clone().text()).slice(0, 300);
        expect(
          denyStatusesFor(entry),
          `${routeKey(entry)} deny ${denied.status} ${snippet}`,
        ).toContain(denied.status);
      }

      if (entry.allowProbe) {
        if (entry.gate.kind === 'public') sessionBox.current = null;
        else if (entry.allowRole) applyActor({ type: 'role', slug: entry.allowRole });
        const allowed = await invoke(
          entry,
          entry.allowRole ? userIdFor(null, entry.allowRole) : null,
          organisationId,
        );
        const snippet = (await allowed.clone().text()).slice(0, 300);
        expect(
          allowed.status,
          `${routeKey(entry)} allow ${allowed.status} ${snippet}`,
        ).toBeGreaterThanOrEqual(200);
        expect(
          allowed.status,
          `${routeKey(entry)} allow ${allowed.status} ${snippet}`,
        ).toBeLessThan(300);
      }
    },
    30_000,
  );
});
