import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client', () => ({
  db: { execute: vi.fn(async () => []) },
}));

vi.mock('@/lib/redis', () => ({
  pingRedis: vi.fn(async () => true),
}));

vi.mock('@/lib/storage/s3', () => ({
  checkS3: vi.fn(async () => true),
}));

vi.mock('@/lib/observability/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Black-hole the scanner. No 'timeout' or 'error' event, so only the explicit
// probe timer can finish the check — the same shape as a ClusterIP with no
// endpoints.
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');

  class Socket extends EventEmitter {
    setTimeout(): void {}
    connect(): void {}
    write(): void {}
    destroy(): void {}
  }

  return { Socket };
});

import { db } from '@/db/client';
import { __resetReadinessCache, readinessReport } from '@/lib/health/checks';
import { logger } from '@/lib/observability/logger';

const execute = db.execute as unknown as ReturnType<typeof vi.fn>;

describe('readiness probes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetReadinessCache();
    execute.mockReset();
    execute.mockResolvedValue([]);
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    __resetReadinessCache();
    vi.useRealTimers();
  });

  it('stays ready within 1s when ClamAV never connects', async () => {
    const pending = readinessReport();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    const report = await pending;
    expect(report.ready).toBe(true);
    expect(report.checks.database.status).toBe('up');
    expect(report.checks.redis.status).toBe('up');
    expect(report.checks.storage.status).toBe('up');
    expect(report.checks.clamav.status).toBe('down');
  });

  it('reports not-ready when the database does not answer', async () => {
    execute.mockImplementation(() => new Promise(() => {}));

    const pending = readinessReport();
    await vi.advanceTimersByTimeAsync(2_000);
    const report = await pending;

    expect(report.ready).toBe(false);
    expect(report.checks.database.status).toBe('down');
    expect(report.checks.redis.status).toBe('up');
  });

  it('fans out at most once per 5s, including a cold burst', async () => {
    const first = readinessReport();
    const burst = Promise.all(Array.from({ length: 100 }, () => readinessReport()));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, burst]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    await readinessReport();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const second = readinessReport();
    await vi.advanceTimersByTimeAsync(500);
    await second;
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
