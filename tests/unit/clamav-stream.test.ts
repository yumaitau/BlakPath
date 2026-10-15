import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClamAvProtocolError,
  ClamAvUnavailableError,
  scanStream,
} from '@/lib/scanning/clamav';
import { MAX_EVIDENCE_BYTES } from '@/domains/evidence/status';

/**
 * A fake clamd speaking just enough INSTREAM to count the payload it receives.
 * It reads slowly (one socket read per event-loop turn) so the client has to
 * respect backpressure rather than queue the whole object in memory.
 */
interface FakeClamd {
  port: number;
  received: () => number;
  close: () => Promise<void>;
}

async function startFakeClamd(
  reply: (payloadBytes: number) => string | null,
): Promise<FakeClamd> {
  let received = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    let commandRead = false;
    let frameRemaining = 0;
    socket.on('data', (data: Buffer) => {
      socket.pause();
      setImmediate(() => socket.resume());
      pending = Buffer.concat([pending, data]);
      if (!commandRead) {
        const end = pending.indexOf(0);
        if (end < 0) return;
        commandRead = true;
        pending = pending.subarray(end + 1);
      }
      while (pending.length > 0) {
        if (frameRemaining > 0) {
          const take = Math.min(frameRemaining, pending.length);
          received += take;
          frameRemaining -= take;
          pending = pending.subarray(take);
          continue;
        }
        if (pending.length < 4) return;
        frameRemaining = pending.readUInt32BE(0);
        pending = pending.subarray(4);
        if (frameRemaining === 0) {
          const text = reply(received);
          if (text !== null) socket.end(`${text}\0`);
          return;
        }
      }
      const early = reply(received);
      if (early !== null && received > 0) socket.end(`${early}\0`);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    received: () => received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

let clamd: FakeClamd | undefined;
afterEach(async () => {
  await clamd?.close();
  clamd = undefined;
});

/** Lazily yields `total` bytes in fresh 64 KiB buffers, as an S3 body would. */
async function* lazyBytes(total: number, onYield: (produced: number) => void) {
  const size = 64 * 1024;
  let produced = 0;
  while (produced < total) {
    const chunk = Buffer.alloc(Math.min(size, total - produced), 0x41);
    produced += chunk.length;
    onYield(produced);
    yield chunk;
  }
}

describe('scanStream (clamd INSTREAM)', () => {
  it('streams a 25 MiB object with bounded memory', async () => {
    const server = await startFakeClamd((n) =>
      n === MAX_EVIDENCE_BYTES ? 'stream: OK' : null,
    );
    clamd = server;
    let peakInFlight = 0;

    const verdict = await scanStream(
      lazyBytes(MAX_EVIDENCE_BYTES, (produced) => {
        peakInFlight = Math.max(peakInFlight, produced - server.received());
      }),
      { host: '127.0.0.1', port: server.port },
    );

    expect(verdict).toEqual({ clean: true });
    expect(server.received()).toBe(MAX_EVIDENCE_BYTES);
    // Bytes read from the source but not yet delivered to clamd — the most the
    // scanner ever holds — stay within socket buffers, far below the object
    // size. Without backpressure this reaches the full 25 MiB.
    expect(peakInFlight).toBeLessThan(8 * 1024 * 1024);
  }, 60_000);

  it('reports a FOUND verdict', async () => {
    clamd = await startFakeClamd(() => 'stream: Eicar-Test-Signature FOUND');
    const verdict = await scanStream([Buffer.from('X5O!P%@AP')], {
      host: '127.0.0.1',
      port: clamd.port,
    });
    expect(verdict).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
  });

  it('stops reading the source when clamd rejects the stream early', async () => {
    clamd = await startFakeClamd((n) =>
      n >= 1024 * 1024 ? 'INSTREAM size limit exceeded. ERROR' : null,
    );
    let produced = 0;
    const outcome = await scanStream(
      lazyBytes(MAX_EVIDENCE_BYTES, (n) => {
        produced = n;
      }),
      { host: '127.0.0.1', port: clamd.port },
    ).then(
      () => null,
      (err: unknown) => err,
    );
    // clamd closes after rejecting, so the reply can race our next write and
    // surface as a reset. Either way the scan fails secure without a verdict.
    expect(
      outcome instanceof ClamAvProtocolError || outcome instanceof ClamAvUnavailableError,
    ).toBe(true);
    expect(produced).toBeLessThan(MAX_EVIDENCE_BYTES);
  });

  it('fails secure when the source stream errors', async () => {
    clamd = await startFakeClamd(() => null);
    async function* broken() {
      yield Buffer.from('partial');
      throw new Error('storage connection reset');
    }
    await expect(
      scanStream(broken(), { host: '127.0.0.1', port: clamd.port }),
    ).rejects.toBeInstanceOf(ClamAvUnavailableError);
  });

  it('fails secure when clamd is unreachable', async () => {
    const server = await startFakeClamd(() => null);
    const { port } = server;
    await server.close();
    await expect(
      scanStream([Buffer.from('bytes')], { host: '127.0.0.1', port, timeoutMs: 2_000 }),
    ).rejects.toBeInstanceOf(ClamAvUnavailableError);
  });
});
