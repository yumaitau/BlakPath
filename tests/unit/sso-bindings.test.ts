import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, tenantContext } from './helpers/tenant';
import { script } from './helpers/scripted-db';

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));

vi.mock('@/db/tenant-db', async () => {
  const { scriptedTenantModule } = await import('./helpers/scripted-db');
  const { ORG_ID: orgId } = await import('./helpers/tenant');
  return scriptedTenantModule(orgId);
});

vi.mock('@/domains/audit/service', () => ({
  recordAudit: audit.recordAudit,
}));

const { createSsoBinding, listSsoBindings, setSsoBindingEnabled } =
  await import('@/domains/sso');
const { AuthorizationError } = await import('@/lib/permissions/errors');
const { runWithTenantContext } = await import('@/lib/tenancy/context');

const BINDING_ID = '00000000-0000-4000-8000-000000000031';

const input = {
  providerKey: 'entra',
  issuer: 'https://login.example/tenant',
  clientId: 'client-id',
  domain: 'Council.Example',
};

const binding = {
  id: BINDING_ID,
  organisationId: ORG_ID,
  providerKey: 'entra',
  issuer: input.issuer,
  clientId: input.clientId,
  domain: 'council.example',
  enabled: false,
};

function asAdmin<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(tenantContext(['tenant:configure']), fn);
}

beforeEach(() => {
  script.reset();
  audit.recordAudit.mockClear();
});

describe('SSO bindings', () => {
  it('requires tenant:configure', async () => {
    await expect(
      runWithTenantContext(tenantContext([]), () => createSsoBinding(input)),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(script.ops).toEqual([]);
  });

  it('creates a binding disabled, and lowercases the domain', async () => {
    script.results.push([{ ...binding }]);
    const row = await asAdmin(() => createSsoBinding(input));
    expect(row.enabled).toBe(false);
    expect(script.writes[0]?.payload).toMatchObject({
      organisationId: ORG_ID,
      providerKey: 'entra',
      domain: 'council.example',
      enabled: false,
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.settings_updated', result: 'success' }),
    );
  });

  it('rejects an issuer that is not a URL', async () => {
    await expect(
      asAdmin(() => createSsoBinding({ ...input, issuer: 'not-a-url' })),
    ).rejects.toThrow();
    expect(script.ops).toEqual([]);
  });

  it('lists bindings for an admin only', async () => {
    await expect(
      runWithTenantContext(tenantContext([]), () => listSsoBindings()),
    ).rejects.toThrow(AuthorizationError);
    script.results.push([binding]);
    await expect(asAdmin(() => listSsoBindings())).resolves.toEqual([binding]);
  });

  it('will not enable a binding until its domain is verified', async () => {
    script.results.push([binding], []);
    await expect(
      asAdmin(() => setSsoBindingEnabled(BINDING_ID, true)),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(script.ops).toEqual(['select', 'select']);
    expect(script.writes).toEqual([]);

    script.results.push([binding], [{ id: 'domain-1' }], [{ ...binding, enabled: true }]);
    await expect(
      asAdmin(() => setSsoBindingEnabled(BINDING_ID, true)),
    ).resolves.toMatchObject({
      enabled: true,
    });
    expect(script.writes.at(-1)?.payload).toEqual({ enabled: true });
  });

  it('disables a binding without a fresh domain check', async () => {
    script.results.push([binding], [{ ...binding, enabled: false }]);
    await expect(
      asAdmin(() => setSsoBindingEnabled(BINDING_ID, false)),
    ).resolves.toMatchObject({
      enabled: false,
    });
    expect(script.ops).toEqual(['select', 'update']);
  });

  it('refuses a binding row from another organisation', async () => {
    script.results.push([
      { ...binding, organisationId: '00000000-0000-4000-8000-000000000099' },
    ]);
    await expect(asAdmin(() => setSsoBindingEnabled(BINDING_ID, false))).rejects.toThrow(
      /tenant scope/,
    );
  });
});
