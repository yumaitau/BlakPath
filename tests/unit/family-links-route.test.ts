import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '@/lib/permissions/errors';

const service = vi.hoisted(() => ({
  listFamilyLinks: vi.fn(),
  requestFamilyLink: vi.fn(),
  approveFamilyLink: vi.fn(),
  disputeFamilyLink: vi.fn(),
  withdrawFamilyLink: vi.fn(),
}));

vi.mock('@/domains/family-links', () => service);

vi.mock('@/lib/http/tenant-route', async () => {
  const actual = (await vi.importActual('@/lib/http/tenant-route')) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    withRequestTenant: (fn: () => Promise<unknown>) => fn(),
  };
});

const { GET, POST } = await import('@/app/api/applications/[id]/family-links/route');
const { PATCH } = await import('@/app/api/applications/[id]/family-links/[linkId]/route');

beforeEach(() => {
  service.listFamilyLinks.mockReset();
  service.requestFamilyLink.mockReset();
  service.approveFamilyLink.mockReset();
  service.disputeFamilyLink.mockReset();
  service.withdrawFamilyLink.mockReset();
});

describe('family-link routes', () => {
  it('lists and records links for the application', async () => {
    service.listFamilyLinks.mockResolvedValue([
      { id: 'link-1', relativeName: 'Aunty May' },
    ]);
    const listed = await GET(new Request('http://localhost/api'), {
      params: Promise.resolve({ id: 'app-1' }),
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      links: [{ id: 'link-1', relativeName: 'Aunty May' }],
    });
    expect(service.listFamilyLinks).toHaveBeenCalledWith('app-1');

    service.requestFamilyLink.mockResolvedValue({ id: 'link-2', status: 'requested' });
    const created = await POST(
      new Request('http://localhost/api', {
        method: 'POST',
        body: JSON.stringify({ relationship: 'grandmother', relativeName: 'Aunty May' }),
      }),
      { params: Promise.resolve({ id: 'app-1' }) },
    );
    expect(created.status).toBe(201);
    expect(service.requestFamilyLink).toHaveBeenCalledWith('app-1', {
      relationship: 'grandmother',
      relativeName: 'Aunty May',
    });
  });

  it('returns 403 when the same person is refused the decision', async () => {
    service.approveFamilyLink.mockRejectedValue(
      new AuthorizationError(
        'SEPARATION_OF_DUTIES',
        'This action must be carried out by a different person.',
      ),
    );
    const response = await PATCH(
      new Request('http://localhost/api', {
        method: 'PATCH',
        body: JSON.stringify({ operation: 'approve', note: 'mine' }),
      }),
      { params: Promise.resolve({ id: 'app-1', linkId: 'link-1' }) },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    expect(service.approveFamilyLink).toHaveBeenCalledWith('app-1', 'link-1', {
      note: 'mine',
    });
  });

  it('routes dispute and withdraw to the matching service call', async () => {
    service.disputeFamilyLink.mockResolvedValue({ id: 'link-1', status: 'disputed' });
    service.withdrawFamilyLink.mockResolvedValue({ id: 'link-1', status: 'withdrawn' });

    const disputed = await PATCH(
      new Request('http://localhost/api', {
        method: 'PATCH',
        body: JSON.stringify({ operation: 'dispute' }),
      }),
      { params: Promise.resolve({ id: 'app-1', linkId: 'link-1' }) },
    );
    expect(disputed.status).toBe(200);
    expect(service.disputeFamilyLink).toHaveBeenCalledWith('app-1', 'link-1', {
      note: undefined,
    });

    const withdrawn = await PATCH(
      new Request('http://localhost/api', {
        method: 'PATCH',
        body: JSON.stringify({ operation: 'withdraw' }),
      }),
      { params: Promise.resolve({ id: 'app-1', linkId: 'link-1' }) },
    );
    expect(withdrawn.status).toBe(200);
    expect(service.withdrawFamilyLink).toHaveBeenCalledWith('app-1', 'link-1');
  });
});
