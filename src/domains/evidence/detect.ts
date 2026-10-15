import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { fileTypeFromStream } from 'file-type';

/**
 * Detect a stream's real content type from its magic bytes. `file-type` reads
 * only as far as it needs (a few KB for most formats, entry headers for
 * Office Open XML), so a large object is never buffered whole. The stream is
 * always destroyed afterwards; it is a probe, not the scan.
 *
 * Server-only (worker). The pure rules that interpret the result live in
 * `status.ts`.
 */
export async function detectContentType(body: Readable): Promise<string | undefined> {
  try {
    const web = Readable.toWeb(body) as ReadableStream<Uint8Array>;
    return (await fileTypeFromStream(web))?.mime;
  } finally {
    body.destroy();
  }
}
