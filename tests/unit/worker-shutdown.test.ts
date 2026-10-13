import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetShutdownForTests,
  shutdown,
  type ShutdownDeps,
} from '../../worker/shutdown';

function logger(): Pick<Logger, 'info' | 'error'> {
  return {
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Pick<Logger, 'info' | 'error'>;
}

function deps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
  return {
    graceMs: 5_000,
    heartbeatPresent: true,
    workers: [{ close: vi.fn(async () => undefined) }],
    stopScheduler: vi.fn(),
    stopHeartbeat: vi.fn(),
    closeQueues: vi.fn(async () => undefined),
    quitRedis: vi.fn(async () => undefined),
    log: logger(),
    exit: vi.fn(),
    setDeadline: () => ({ clear: vi.fn() }),
    ...overrides,
  };
}

describe('worker shutdown', () => {
  afterEach(() => {
    __resetShutdownForTests();
  });

  it('drains jobs and logs shutdown complete', async () => {
    const order: string[] = [];
    const close = vi.fn(async () => {
      order.push('workers');
    });
    const input = deps({
      workers: [{ close }],
      stopHeartbeat: () => order.push('heartbeat'),
      stopScheduler: () => order.push('scheduler'),
      closeQueues: async () => {
        order.push('queues');
      },
      quitRedis: async () => {
        order.push('redis');
      },
      setDeadline: () => ({
        clear: () => order.push('clear'),
      }),
    });

    await shutdown('SIGTERM', input);

    expect(order).toEqual([
      'heartbeat',
      'scheduler',
      'workers',
      'queues',
      'redis',
      'clear',
    ]);
    expect(close.mock.calls).toEqual([[]]);
    expect(input.log.info).toHaveBeenCalledWith('shutdown complete');
    expect(input.exit).toHaveBeenCalledWith(0);
    expect(input.exit).not.toHaveBeenCalledWith(1);
  });

  it('forces close when the heartbeat is already gone and still completes', async () => {
    const close = vi.fn(async () => undefined);
    let release: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = deps({
      heartbeatPresent: false,
      forceStepMs: 30,
      workers: [{ close }],
      quitRedis: () => hung,
    });

    await shutdown('SIGTERM', input);

    expect(close).toHaveBeenCalledWith(true);
    expect(input.log.info).toHaveBeenCalledWith(
      'redis heartbeat missing — forcing worker close',
    );
    expect(input.log.info).toHaveBeenCalledWith('shutdown complete');
    expect(input.exit).toHaveBeenCalledWith(0);
    release?.();
  });

  it('exits 1 when the drain outlives the grace period', async () => {
    const input = deps({
      graceMs: 20,
      workers: [{ close: () => new Promise<void>(() => undefined) }],
      setDeadline: (fire, ms) => {
        const timer = setTimeout(fire, ms);
        return { clear: () => clearTimeout(timer) };
      },
    });

    const pending = shutdown('SIGTERM', input);
    await vi.waitFor(() => expect(input.exit).toHaveBeenCalledWith(1));
    expect(input.log.error).toHaveBeenCalledWith(
      { graceMs: 20 },
      'shutdown deadline exceeded — forcing exit',
    );
    void pending;
  });

  it('ignores a second signal while draining', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => gate);
    const input = deps({ workers: [{ close }] });

    const first = shutdown('SIGTERM', input);
    const second = shutdown('SIGINT', input);
    release?.();
    await Promise.all([first, second]);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when the drain throws', async () => {
    const input = deps({
      workers: [
        {
          close: async () => {
            throw new Error('close failed');
          },
        },
      ],
    });

    await shutdown('SIGINT', input);

    expect(input.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'error during shutdown',
    );
    expect(input.exit).toHaveBeenCalledWith(1);
  });
});
