import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Worker scan lifecycle with storage, scanner and database stubbed out. Proves
 * the integrity checks that sit between the client's PUT and promotion:
 *   - the stored size must equal the declared size;
 *   - the stored Content-Type is the type verified from magic bytes;
 *   - every read and the promotion copy are pinned to the HeadObject ETag.
 */

const patches: Array<Record<string, unknown>> = [];
let evidenceRow: Record<string, unknown> = {};

vi.mock('@/db/tenant-db', () => ({
  currentScope: () => {
    throw new Error('not used by the worker path');
  },
  scopeFor: (organisationId: string) => {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve([{ organisationId, ...evidenceRow }]),
    };
    return {
      organisationId,
      db: {
        select: () => chain,
        update: () => ({
          set: (patch: Record<string, unknown>) => {
            patches.push(patch);
            return { where: () => Promise.resolve() };
          },
        }),
      },
    };
  },
}));
vi.mock('@/domains/audit/service', () => ({ recordAudit: vi.fn(async () => ({})) }));
vi.mock('@/domains/applications', () => ({ getApplication: vi.fn() }));
vi.mock('@/domains/notifications', () => ({ queueNotification: vi.fn() }));
vi.mock('@/lib/queues', () => ({ addJob: vi.fn(), QueueName: { MalwareScan: 'scan' } }));

let objectBytes: Buffer = Buffer.alloc(0);
let storedLength: number | undefined;
let quarantineMissing = false;
let promotedHead: { contentLength: number; contentType: string; etag: string } | null =
  null;
const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound' });
const storage = {
  headObject: vi.fn(async (params: { bucket: string }) => {
    if (params.bucket === 'evidence') {
      if (!promotedHead) throw notFound();
      return promotedHead;
    }
    if (quarantineMissing) throw notFound();
    return {
      contentLength: storedLength,
      contentType: 'application/octet-stream',
      etag: '"etag-1"',
    };
  }),
  isMissingObject: (err: unknown) => (err as { name?: string })?.name === 'NotFound',
  getObjectStream: vi.fn(async () => Readable.from([objectBytes])),
  deleteObject: vi.fn(async () => undefined),
  moveQuarantineToEvidence: vi.fn(async (params: { key: string }) => ({
    bucket: 'evidence',
    key: params.key,
  })),
};
vi.mock('@/lib/storage/s3', () => ({
  ...storage,
  EVIDENCE_BUCKET: 'evidence',
  QUARANTINE_BUCKET: 'quarantine',
  objectKey: (...parts: string[]) => parts.join('/'),
  presignDownload: vi.fn(),
  presignUpload: vi.fn(),
}));

const scanned: number[] = [];
vi.mock('@/lib/scanning/clamav', () => ({
  scanStream: vi.fn(async (source: AsyncIterable<Uint8Array>) => {
    let bytes = 0;
    for await (const chunk of source) bytes += chunk.length;
    scanned.push(bytes);
    return { clean: true };
  }),
}));

const { processEvidenceScan } = await import('@/domains/evidence/service');

function fixture(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/evidence/${name}`, import.meta.url));
}

function upload(params: {
  fixtureName: string;
  fileName: string;
  declaredContentType: string;
  declaredSize?: number;
  storedSize?: number;
}) {
  objectBytes = fixture(params.fixtureName);
  storedLength = params.storedSize ?? objectBytes.length;
  evidenceRow = {
    id: 'ev-1',
    status: 'quarantined',
    quarantineKey: 'org-1/applications/app-1/evidence/ev-1',
    fileName: params.fileName,
    declaredContentType: params.declaredContentType,
    sizeBytes: params.declaredSize ?? objectBytes.length,
    uploadedByUserId: 'user-1',
  };
}

const run = () =>
  processEvidenceScan({
    organisationId: 'org-1',
    evidenceId: 'ev-1',
    correlationId: 'corr-1',
  });

beforeEach(() => {
  quarantineMissing = false;
  promotedHead = null;
  patches.length = 0;
  scanned.length = 0;
  vi.clearAllMocks();
});

describe('processEvidenceScan integrity checks', () => {
  it('rejects an object whose stored size differs from the declared size', async () => {
    upload({
      fixtureName: 'letter.doc',
      fileName: 'letter.doc',
      declaredContentType: 'application/msword',
      declaredSize: 1024,
    });
    await run();
    expect(patches).toEqual([
      expect.objectContaining({ status: 'rejected', scanResult: 'rejected:size' }),
    ]);
    expect(storage.deleteObject).toHaveBeenCalledOnce();
    expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(storage.moveQuarantineToEvidence).not.toHaveBeenCalled();
  });

  it('promotes a real .doc with the verified type as its stored Content-Type', async () => {
    upload({
      fixtureName: 'letter.doc',
      fileName: 'letter.doc',
      declaredContentType: 'application/msword',
    });
    await run();
    expect(storage.moveQuarantineToEvidence).toHaveBeenCalledWith({
      organisationId: 'org-1',
      key: 'org-1/applications/app-1/evidence/ev-1',
      contentType: 'application/msword',
      ifMatch: '"etag-1"',
    });
    for (const call of storage.getObjectStream.mock.calls as unknown as Array<
      [{ ifMatch: string }]
    >) {
      expect(call[0].ifMatch).toBe('"etag-1"');
    }
    expect(scanned).toEqual([objectBytes.length]);
    expect(patches).toEqual([
      expect.objectContaining({
        status: 'clean',
        detectedContentType: 'application/msword',
        sha256: createHash('sha256').update(objectBytes).digest('hex'),
      }),
    ]);
  });

  it('stores a mif1 HEIF declared as HEIC under its detected type', async () => {
    upload({
      fixtureName: 'photo-mif1.heif',
      fileName: 'IMG_0002.HEIC',
      declaredContentType: 'image/heic',
    });
    await run();
    expect(storage.moveQuarantineToEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/heif' }),
    );
  });

  it('rejects an executable renamed to .doc before scanning', async () => {
    upload({
      fixtureName: 'renamed-exe.doc',
      fileName: 'renamed-exe.doc',
      declaredContentType: 'application/msword',
    });
    await run();
    expect(patches).toEqual([
      expect.objectContaining({
        status: 'rejected',
        scanResult: 'rejected:content-type',
        detectedContentType: 'application/x-msdownload',
      }),
    ]);
    expect(scanned).toEqual([]);
    expect(storage.moveQuarantineToEvidence).not.toHaveBeenCalled();
  });
});

describe('processEvidenceScan missing quarantine object', () => {
  it('rejects instead of retrying when nothing was promoted', async () => {
    upload({
      fixtureName: 'letter.doc',
      fileName: 'letter.doc',
      declaredContentType: 'application/msword',
    });
    quarantineMissing = true;
    await run();
    expect(patches).toEqual([
      expect.objectContaining({
        status: 'rejected',
        scanResult: 'rejected:missing-object',
      }),
    ]);
    expect(scanned).toEqual([]);
    expect(storage.moveQuarantineToEvidence).not.toHaveBeenCalled();
  });

  it('settles a copy promoted before a crash as clean without rescanning', async () => {
    upload({
      fixtureName: 'letter.doc',
      fileName: 'letter.doc',
      declaredContentType: 'application/msword',
    });
    quarantineMissing = true;
    promotedHead = {
      contentLength: objectBytes.length,
      contentType: 'application/msword',
      etag: '"etag-2"',
    };
    await run();
    expect(storage.getObjectStream).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'evidence', ifMatch: '"etag-2"' }),
    );
    expect(patches).toEqual([
      expect.objectContaining({
        status: 'clean',
        detectedContentType: 'application/msword',
        sha256: createHash('sha256').update(objectBytes).digest('hex'),
      }),
    ]);
    expect(scanned).toEqual([]);
  });

  it('does not treat a promoted copy of the wrong size as clean', async () => {
    upload({
      fixtureName: 'letter.doc',
      fileName: 'letter.doc',
      declaredContentType: 'application/msword',
    });
    quarantineMissing = true;
    promotedHead = {
      contentLength: objectBytes.length + 1,
      contentType: 'application/msword',
      etag: '"etag-2"',
    };
    await run();
    expect(patches).toEqual([
      expect.objectContaining({
        status: 'rejected',
        scanResult: 'rejected:missing-object',
      }),
    ]);
  });
});
