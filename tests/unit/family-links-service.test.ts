import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse } from '@/lib/http/error-response';
import { AuthorizationError } from '@/lib/permissions/errors';

interface StoredLink {
  id: string;
  organisationId: string;
  applicationId: string;
  requestedByUserId: string | null;
  relationship: string;
  relativeName: string;
  community: string | null;
  notes: string | null;
  relativeDeceased: boolean;
  status: string;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: Date;
  deletedAt: null;
}

const state = vi.hoisted(() => ({
  userId: 'genealogy-a',
  organisationId: 'org-1',
  permissions: new Set<string>([
    'family-link:request',
    'family-link:approve',
    'application:read-assigned',
  ]),
  rows: [] as StoredLink[],
  audits: [] as Array<Record<string, unknown>>,
  updates: 0,
}));

vi.mock('@/db/tenant-db', () => {
  function rowFrom(values: Record<string, unknown>): StoredLink {
    const now = new Date('2026-10-13T00:00:00.000Z');
    return {
      id: String(values.id),
      organisationId: String(values.organisationId),
      applicationId: String(values.applicationId),
      requestedByUserId: (values.requestedByUserId as string | null) ?? null,
      relationship: String(values.relationship),
      relativeName: String(values.relativeName),
      community: (values.community as string | null) ?? null,
      notes: (values.notes as string | null) ?? null,
      relativeDeceased: Boolean(values.relativeDeceased),
      status: String(values.status ?? 'requested'),
      decidedByUserId: (values.decidedByUserId as string | null) ?? null,
      decidedAt: (values.decidedAt as Date | null) ?? null,
      decisionNote: (values.decisionNote as string | null) ?? null,
      createdAt: now,
      updatedAt: now,
      version: now,
      deletedAt: null,
    };
  }

  type Query = {
    from: () => Query;
    where: () => Query;
    orderBy: () => Query;
    limit: () => Query;
    set: (values: Record<string, unknown>) => Query;
    values: (values: Record<string, unknown>) => Query;
    returning: () => Promise<StoredLink[]>;
    then: (
      resolve: (value: StoredLink[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise<unknown>;
  };

  function builder(run: () => StoredLink[]) {
    const query: Query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      set: () => query,
      values: (values) => {
        const row = rowFrom(values);
        state.rows.push(row);
        query.returning = () => Promise.resolve([row]);
        return query;
      },
      returning: () => Promise.resolve(run()),
      then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
    };
    return query;
  }

  const db: Record<string, unknown> = {
    select: () => builder(() => state.rows),
    insert: () => builder(() => state.rows),
    update: () => {
      let patch: Record<string, unknown> = {};
      const query = builder(() => state.rows);
      query.set = (values: Record<string, unknown>) => {
        patch = values;
        return query;
      };
      query.returning = () => {
        state.updates += 1;
        const row = state.rows[0];
        if (!row) return Promise.resolve([]);
        Object.assign(row, patch);
        return Promise.resolve([row]);
      };
      return query;
    },
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };

  return {
    currentScope: () => ({
      organisationId: state.organisationId,
      db,
      where: (orgColumn: unknown) => ({ orgColumn }),
      assertOwned: <T>(row: T) => row,
      insertValues: <T extends Record<string, unknown>>(values: T) => ({
        ...values,
        organisationId: state.organisationId,
      }),
    }),
  };
});

// Reversible stand-in for the tenant key: bound to org, column and row.
vi.mock('@/lib/encryption/tenant-fields', () => {
  const seal = (org: string, column: string, id: string, value: string | null) =>
    value === null
      ? null
      : `sealed:${Buffer.from(JSON.stringify([org, column, id, value])).toString('base64')}`;
  const open = (org: string, column: string, id: string, value: string | null) => {
    if (value === null || !value.startsWith('sealed:')) return value;
    const [o, c, i, p] = JSON.parse(
      Buffer.from(value.slice('sealed:'.length), 'base64').toString('utf8'),
    ) as string[];
    if (o !== org || c !== column || i !== id) throw new Error('binding mismatch');
    return p ?? null;
  };
  return {
    sealFamilyFields: async (
      org: string,
      id: string,
      fields: { relativeName: string; community: string | null; notes: string | null },
    ) => ({
      relativeName: seal(org, 'relative_name', id, fields.relativeName),
      community: seal(org, 'community', id, fields.community),
      notes: seal(org, 'notes', id, fields.notes),
    }),
    sealFamilyDecisionNote: async (org: string, id: string, note: string | null) =>
      seal(org, 'decision_note', id, note),
    openFamilyRows: async (org: string, rows: StoredLink[]) =>
      rows.map((row) => ({
        ...row,
        relativeName: open(org, 'relative_name', row.id, row.relativeName) ?? '',
        community: open(org, 'community', row.id, row.community),
        notes: open(org, 'notes', row.id, row.notes),
        decisionNote: open(org, 'decision_note', row.id, row.decisionNote),
      })),
  };
});

vi.mock('@/lib/tenancy/context', () => ({
  requireTenantContext: () => ({
    userId: state.userId,
    organisationId: state.organisationId,
    permissions: state.permissions,
  }),
}));

vi.mock('@/domains/applications', () => ({
  getApplication: vi.fn(async () => ({ application: { id: 'app-1' } })),
}));

vi.mock('@/domains/audit/service', () => ({
  recordAudit: vi.fn(async (input: Record<string, unknown>) => {
    state.audits.push(input);
    return { id: 'audit-1', hash: 'h', prevHash: null, timestamp: new Date() };
  }),
}));

const {
  approveFamilyLink,
  disputeFamilyLink,
  listFamilyLinks,
  requestFamilyLink,
  withdrawFamilyLink,
} = await import('@/domains/family-links/service');

const input = {
  relationship: 'grandmother',
  relativeName: 'Aunty May',
  community: 'Example Nation',
  notes: 'Maternal line, as told by the applicant.',
  relativeDeceased: true,
};

beforeEach(() => {
  state.userId = 'genealogy-a';
  state.permissions = new Set([
    'family-link:request',
    'family-link:approve',
    'application:read-assigned',
  ]);
  state.rows.length = 0;
  state.audits.length = 0;
  state.updates = 0;
});

describe('family-link service', () => {
  it('records a sealed link and returns the plaintext to the genealogy officer', async () => {
    const link = await requestFamilyLink('app-1', input);
    expect(link.relativeName).toBe('Aunty May');
    expect(link.community).toBe('Example Nation');
    expect(link.notes).toBe(input.notes);
    expect(link.relativeDeceased).toBe(true);
    expect(link.status).toBe('requested');

    const stored = state.rows[0];
    expect(stored?.relativeName.includes('Aunty May')).toBe(false);
    expect(stored?.community?.includes('Example Nation')).toBe(false);
    expect(stored?.notes?.includes('Maternal')).toBe(false);
    expect(stored?.relativeDeceased).toBe(true);
    expect(state.audits[0]).toMatchObject({
      action: 'family_link.created',
      result: 'success',
      after: { data: { relativeDeceased: true } },
    });
  });

  it('refuses the same person approving or disputing, with 403 and a denial audit', async () => {
    const link = await requestFamilyLink('app-1', input);

    await expect(
      approveFamilyLink('app-1', link.id, { note: 'looks right' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    try {
      await approveFamilyLink('app-1', link.id);
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).code).toBe('SEPARATION_OF_DUTIES');
      expect(errorResponse(error).status).toBe(403);
    }

    await expect(disputeFamilyLink('app-1', link.id)).rejects.toMatchObject({
      code: 'SEPARATION_OF_DUTIES',
    });

    expect(state.updates).toBe(0);
    expect(state.rows[0]?.status).toBe('requested');
    const denials = state.audits.filter((audit) => audit.result === 'denied');
    expect(denials).toEqual([
      expect.objectContaining({
        action: 'family_link.confirmed',
        resourceId: link.id,
        result: 'denied',
        reason: 'family_link.separation_of_duties',
      }),
      expect.objectContaining({
        action: 'family_link.confirmed',
        result: 'denied',
      }),
      expect.objectContaining({
        action: 'family_link.disputed',
        result: 'denied',
      }),
    ]);
  });

  it('lets a different person approve, and the requester withdraw before that', async () => {
    const link = await requestFamilyLink('app-1', input);
    state.userId = 'genealogy-b';
    const approved = await approveFamilyLink('app-1', link.id, {
      note: 'Records match the family account.',
    });
    expect(approved.status).toBe('approved');
    expect(approved.decisionNote).toBe('Records match the family account.');
    expect(approved.relativeName).toBe('Aunty May');
    expect(state.rows[0]?.decisionNote?.includes('Records match')).toBe(false);
    expect(
      state.audits.some(
        (audit) => audit.action === 'family_link.confirmed' && audit.result === 'success',
      ),
    ).toBe(true);

    state.rows[0]!.status = 'requested';
    state.rows[0]!.decisionNote = null;
    state.userId = 'genealogy-a';
    const withdrawn = await withdrawFamilyLink('app-1', link.id);
    expect(withdrawn.status).toBe('withdrawn');

    state.rows[0]!.status = 'requested';
    state.userId = 'genealogy-b';
    await expect(withdrawFamilyLink('app-1', link.id)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('lists decrypted links for the application', async () => {
    await requestFamilyLink('app-1', input);
    const links = await listFamilyLinks('app-1');
    expect(links).toHaveLength(1);
    expect(links[0]?.relativeName).toBe('Aunty May');
    expect(links[0]).not.toHaveProperty('organisationId');
  });

  it('refuses the list to an applicant who can request but not read staff cases', async () => {
    await requestFamilyLink('app-1', input);
    state.permissions = new Set(['family-link:request', 'application:read-own']);
    await expect(listFamilyLinks('app-1')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('refuses a decision on a link from another application', async () => {
    const link = await requestFamilyLink('app-1', input);
    state.userId = 'genealogy-b';
    await expect(approveFamilyLink('app-2', link.id)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(state.updates).toBe(0);
  });
});
