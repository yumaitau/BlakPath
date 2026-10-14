// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TENANT_KEY_UNAVAILABLE_MESSAGE,
  TenantKeyUnavailableError,
} from '@/lib/encryption/errors';
import { AuthorizationError } from '@/lib/permissions/errors';

const withRequestTenant = vi.hoisted(() => vi.fn());
const handlePageError = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/lib/http/tenant-route', () => ({ withRequestTenant }));
vi.mock('@/lib/http/page-errors', () => ({ handlePageError }));
vi.mock('@/domains/correspondence', () => ({ listTemplates: vi.fn(async () => []) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { default: CorrespondenceTemplatesPage } =
  await import('@/app/(staff)/settings/correspondence/page');

async function html(): Promise<string> {
  return renderToStaticMarkup(await CorrespondenceTemplatesPage());
}

describe('letter templates settings page', () => {
  beforeEach(() => {
    withRequestTenant.mockReset();
    handlePageError.mockClear();
  });

  it('shows the key-locked message when the tenant key is unavailable', async () => {
    withRequestTenant.mockRejectedValue(new TenantKeyUnavailableError('org-1', 423));
    const page = await html();
    expect(page).toContain(TENANT_KEY_UNAVAILABLE_MESSAGE.replaceAll("'", '&#x27;'));
    expect(page).not.toContain('Your role cannot edit letter templates.');
    expect(handlePageError).not.toHaveBeenCalled();
  });

  it('shows the permission message for an authorisation refusal', async () => {
    withRequestTenant.mockRejectedValue(new AuthorizationError('POLICY_DENIED'));
    const page = await html();
    expect(page).toContain('Your role cannot edit letter templates.');
    expect(handlePageError).toHaveBeenCalledTimes(1);
  });

  it('renders the editor when templates load', async () => {
    withRequestTenant.mockResolvedValue({ state: 'ok', templates: [] });
    const page = await html();
    expect(page).toContain('Add starter templates');
  });
});
