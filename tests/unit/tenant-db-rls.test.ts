import { describe, expect, it } from 'vitest';
import {
  APPLY_RLS_SQL,
  applyRlsContext,
  PLATFORM_CONTEXT,
  rlsSettings,
  sameRlsContext,
  tenantContext,
} from '@/db/rls';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('row-level security context', () => {
  it('refuses a tenant context without an organisation uuid', () => {
    expect(() => tenantContext('')).toThrow(/organisation uuid/);
    expect(() => tenantContext("x' or true --")).toThrow(/organisation uuid/);
    expect(tenantContext(ORG)).toEqual({ kind: 'tenant', organisationId: ORG });
  });

  it('tenant settings name the organisation and keep the bypass off', () => {
    expect(rlsSettings(tenantContext(ORG))).toEqual({
      role: 'blakpath_app',
      organisationId: ORG,
      bypass: 'off',
    });
  });

  it('platform settings clear the organisation and turn the bypass on', () => {
    expect(rlsSettings(PLATFORM_CONTEXT)).toEqual({
      role: 'blakpath_app',
      organisationId: '',
      bypass: 'on',
    });
  });

  it('compares contexts by kind and organisation', () => {
    expect(sameRlsContext(tenantContext(ORG), tenantContext(ORG))).toBe(true);
    expect(sameRlsContext(tenantContext(ORG), tenantContext(OTHER))).toBe(false);
    expect(sameRlsContext(tenantContext(ORG), PLATFORM_CONTEXT)).toBe(false);
    expect(sameRlsContext(PLATFORM_CONTEXT, PLATFORM_CONTEXT)).toBe(true);
  });

  it('applies all three settings transaction-locally in one parameterised call', async () => {
    const calls: Array<{ query: string; parameters: string[] }> = [];
    await applyRlsContext(
      {
        unsafe: async (query, parameters) => {
          calls.push({ query, parameters });
        },
      },
      tenantContext(ORG),
    );
    expect(calls).toEqual([
      { query: APPLY_RLS_SQL, parameters: ['blakpath_app', ORG, 'off'] },
    ]);
    // `true` = SET LOCAL. A session-level setting would leak through the pool.
    expect(APPLY_RLS_SQL.match(/, true\)/g)).toHaveLength(3);
    expect(APPLY_RLS_SQL).not.toContain(ORG);
  });
});
