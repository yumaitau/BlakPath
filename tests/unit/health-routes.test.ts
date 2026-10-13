import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detailedHealthForbidden } from '@/lib/health/access';

vi.mock('@/lib/health/checks', () => ({
  readinessReport: vi.fn(),
}));

import { GET as health } from '@/app/api/health/route';
import { GET as live } from '@/app/api/live/route';
import { GET as ready } from '@/app/api/ready/route';
import { readinessReport } from '@/lib/health/checks';

const report = vi.mocked(readinessReport);

const up = { status: 'up' as const };
const readyReport = {
  ready: true,
  checks: { database: up, redis: up, storage: up, clamav: { status: 'down' as const } },
};

describe('detailed health access', () => {
  it('allows direct pod and VPC calls', () => {
    expect(detailedHealthForbidden(new Headers())).toBe(false);
    expect(detailedHealthForbidden(new Headers({ 'x-forwarded-for': '   ' }))).toBe(
      false,
    );
  });

  it.each(['x-forwarded-for', 'cf-connecting-ip', 'cf-ray'])(
    'refuses an edge request that carries %s',
    (header) => {
      expect(detailedHealthForbidden(new Headers({ [header]: '203.0.113.10' }))).toBe(
        true,
      );
    },
  );
});

describe('probe routes', () => {
  beforeEach(() => {
    report.mockReset();
    report.mockResolvedValue(readyReport);
  });

  it('answers liveness without a dependency report', async () => {
    const response = live();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
    expect(report).not.toHaveBeenCalled();
  });

  it('stays ready when ClamAV is down', async () => {
    const response = await ready();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      checks: { clamav: { status: 'down' } },
    });
  });

  it('returns 503 when a core dependency is down', async () => {
    report.mockResolvedValue({
      ready: false,
      checks: {
        database: { status: 'down' },
        redis: up,
        storage: up,
        clamav: up,
      },
    });

    const response = await ready();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: 'not_ready' });
  });

  it('refuses the detailed report at the edge without probing', async () => {
    const response = await health(
      new Request('http://pod.internal/api/health', {
        headers: { 'x-forwarded-for': '203.0.113.10', 'cf-ray': 'edge' },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    expect(report).not.toHaveBeenCalled();
  });

  it('returns the detailed report to a direct caller', async () => {
    const response = await health(new Request('http://pod.internal/api/health'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'healthy',
      service: 'blakpath',
      region: 'ap-southeast-2',
      checks: { clamav: { status: 'down' } },
    });
    expect(report).toHaveBeenCalledTimes(1);
  });
});
