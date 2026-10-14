import { once } from 'node:events';
import net from 'node:net';
import { env } from '@/lib/env';

/**
 * Minimal ClamAV `clamd` client (INSTREAM).
 *
 * We stream bytes to clamd rather than shelling out to `clamscan`, so the
 * scanner runs as a persistent daemon and no file is written to the app tier.
 * The design is FAIL-SECURE: any inability to get a definitive clean/infected
 * verdict — connection refused, timeout, protocol error, clamd `ERROR` reply —
 * is surfaced as a thrown error so the caller keeps the file quarantined and
 * retries. It must NEVER be interpreted as "clean".
 */

/** A definitive scan verdict. Only produced when clamd answered OK or FOUND. */
export interface ScanVerdict {
  readonly clean: boolean;
  /** Malware signature name when `clean` is false. */
  readonly signature?: string;
}

/**
 * The scanner could not be reached or did not return a definitive verdict.
 * Callers MUST treat this as "not scanned" and keep the object quarantined.
 */
export class ClamAvUnavailableError extends Error {
  readonly code = 'CLAMAV_UNAVAILABLE';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ClamAvUnavailableError';
  }
}

/** clamd replied, but with an error or an unrecognised message. Fail secure. */
export class ClamAvProtocolError extends Error {
  readonly code = 'CLAMAV_PROTOCOL_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ClamAvProtocolError';
  }
}

/**
 * Parse a raw clamd INSTREAM reply into a verdict. Pure and exhaustively
 * testable. Throws (never returns "clean") on any error or unexpected reply.
 *
 * Typical replies:
 *   "stream: OK"
 *   "stream: Eicar-Test-Signature FOUND"
 *   "INSTREAM size limit exceeded. ERROR"
 */
export function parseClamdResponse(raw: string): ScanVerdict {
  // clamd terminates replies with a NUL; strip it and surrounding whitespace.
  const reply = raw.replace(/\0/g, '').trim();
  if (reply.length === 0) {
    throw new ClamAvProtocolError('Empty reply from clamd');
  }
  if (/\bERROR\b/.test(reply)) {
    throw new ClamAvProtocolError(`clamd error reply: ${reply}`);
  }
  if (/\bFOUND\b/.test(reply)) {
    // "stream: <SIGNATURE> FOUND" — extract the signature between them.
    const match = reply.match(/:\s*(.+?)\s+FOUND$/);
    return { clean: false, signature: match?.[1] ?? 'unknown' };
  }
  if (/\bOK\b/.test(reply)) {
    return { clean: true };
  }
  throw new ClamAvProtocolError(`Unrecognised clamd reply: ${reply}`);
}

/** Largest chunk we frame in a single INSTREAM length-prefixed block. */
const CHUNK_SIZE = 64 * 1024;

/** Length prefix for one INSTREAM block; a zero length ends the stream. */
function framePrefix(length: number): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(length, 0);
  return size;
}

export interface ScanOptions {
  host?: string;
  port?: number;
  /** Abort the scan after this long with no socket activity, in milliseconds. */
  timeoutMs?: number;
}

/**
 * Scan a byte stream with clamd over INSTREAM. Bytes are forwarded chunk by
 * chunk with socket backpressure, so memory use stays bounded by the chunk size
 * and socket buffers rather than the object size. Resolves with a definitive
 * verdict, or rejects (fail-secure) if the scanner is unavailable, the reply
 * cannot be interpreted, or the source stream fails.
 */
export function scanStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: ScanOptions = {},
): Promise<ScanVerdict> {
  const host = options.host ?? env.CLAMAV_HOST;
  const port = options.port ?? env.CLAMAV_PORT;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise<ScanVerdict>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    // Stops the pump (and so the source) as soon as the scan settles.
    const stop = new AbortController();

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      stop.abort();
      socket.destroy();
      fn();
    };

    const pump = async () => {
      // `z`-prefixed command is NUL-terminated; then the framed stream.
      socket.write('zINSTREAM\0');
      for await (const piece of source) {
        for (let offset = 0; offset < piece.length; offset += CHUNK_SIZE) {
          if (settled) return;
          const chunk = piece.subarray(offset, offset + CHUNK_SIZE);
          socket.write(framePrefix(chunk.length));
          if (!socket.write(chunk)) {
            await once(socket, 'drain', { signal: stop.signal });
          }
        }
      }
      if (!settled) socket.write(framePrefix(0));
    };

    socket.on('connect', () => {
      pump().catch((err: unknown) => {
        // A source (storage) failure is not a verdict: fail secure.
        done(() =>
          reject(
            err instanceof ClamAvUnavailableError
              ? err
              : new ClamAvUnavailableError('scan stream failed', err),
          ),
        );
      });
    });

    socket.on('data', (buf: Buffer) => {
      chunks.push(buf);
      // clamd sends a single NUL-terminated reply; act as soon as we see it.
      if (buf.includes(0)) {
        const reply = Buffer.concat(chunks).toString('utf8');
        try {
          const verdict = parseClamdResponse(reply);
          done(() => resolve(verdict));
        } catch (err) {
          done(() => reject(err));
        }
      }
    });

    socket.on('timeout', () => {
      done(() =>
        reject(new ClamAvUnavailableError(`clamd scan timed out after ${timeoutMs}ms`)),
      );
    });

    socket.on('error', (err) => {
      done(() => reject(new ClamAvUnavailableError('clamd connection error', err)));
    });

    socket.on('close', () => {
      // Closed before a parseable reply arrived — treat as unavailable.
      done(() => reject(new ClamAvUnavailableError('clamd closed before replying')));
    });
  });
}

/**
 * Send one NUL-terminated clamd command and return the raw reply.
 * Fails closed, the same way a scan does, when clamd does not answer.
 */
export function clamdTextCommand(
  command: string,
  options: ScanOptions = {},
): Promise<string> {
  const host = options.host ?? env.CLAMAV_HOST;
  const port = options.port ?? env.CLAMAV_PORT;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.on('connect', () => {
      socket.write(`z${command}\0`);
    });

    socket.on('data', (buf: Buffer) => {
      chunks.push(buf);
      if (buf.includes(0)) {
        done(() => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    });

    socket.on('timeout', () => {
      done(() =>
        reject(
          new ClamAvUnavailableError(`clamd ${command} timed out after ${timeoutMs}ms`),
        ),
      );
    });

    socket.on('error', (err) => {
      done(() => reject(new ClamAvUnavailableError('clamd connection error', err)));
    });

    socket.on('close', () => {
      done(() => reject(new ClamAvUnavailableError('clamd closed before replying')));
    });
  });
}

/** Scan an in-memory buffer with clamd. Prefer scanStream for objects. */
export function scanBuffer(
  data: Buffer,
  options: ScanOptions = {},
): Promise<ScanVerdict> {
  return scanStream([data], options);
}

/** Reachability probe (PING/PONG) for readiness checks. */
export function pingClamd(options: ScanOptions = {}): Promise<boolean> {
  const host = options.host ?? env.CLAMAV_HOST;
  const port = options.port ?? env.CLAMAV_PORT;
  const timeoutMs = options.timeoutMs ?? 2_000;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (buf: Buffer) => finish(buf.toString('utf8').includes('PONG')));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}
