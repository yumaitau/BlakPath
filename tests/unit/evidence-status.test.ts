import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CONTENT_TYPES,
  EVIDENCE_STATUSES,
  MAX_EVIDENCE_BYTES,
  UPLOAD_ACCEPT,
  contentTypeAcceptable,
  inferUploadContentType,
  isAllowedContentType,
  isServable,
  isTerminalEvidenceStatus,
  uploadProblem,
  uploadSizeAcceptable,
  verifiedContentType,
} from '@/domains/evidence/status';

describe('evidence servability (fail-secure)', () => {
  it('only clean evidence is servable', () => {
    for (const status of EVIDENCE_STATUSES) {
      expect(isServable(status)).toBe(status === 'clean');
    }
  });

  it('clean/infected/rejected are terminal; pending/quarantined are not', () => {
    expect(isTerminalEvidenceStatus('clean')).toBe(true);
    expect(isTerminalEvidenceStatus('infected')).toBe(true);
    expect(isTerminalEvidenceStatus('rejected')).toBe(true);
    expect(isTerminalEvidenceStatus('pending')).toBe(false);
    expect(isTerminalEvidenceStatus('quarantined')).toBe(false);
  });
});

describe('upload allow-list', () => {
  it('accepts documents/images and rejects executables/archives', () => {
    expect(isAllowedContentType('application/pdf')).toBe(true);
    expect(isAllowedContentType('image/png')).toBe(true);
    expect(isAllowedContentType('application/x-msdownload')).toBe(false);
    expect(isAllowedContentType('application/zip')).toBe(false);
    expect(ALLOWED_CONTENT_TYPES.has('image/jpeg')).toBe(true);
  });

  it('has a sane size cap', () => {
    expect(MAX_EVIDENCE_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('post-upload content-type verification', () => {
  it('accepts a detected type that matches an allowed declared type', () => {
    expect(contentTypeAcceptable('application/pdf', 'application/pdf')).toBe(true);
    expect(contentTypeAcceptable('image/png', 'image/png')).toBe(true);
  });

  it('rejects a spoofed type (declared image, detected something else)', () => {
    expect(contentTypeAcceptable('image/png', 'application/pdf')).toBe(false);
    expect(contentTypeAcceptable('image/png', 'application/x-msdownload')).toBe(false);
  });

  it('rejects a disallowed declared type outright', () => {
    expect(contentTypeAcceptable('application/zip', 'application/zip')).toBe(false);
  });

  it('requires a positive detection for every type', () => {
    expect(contentTypeAcceptable('application/pdf', undefined)).toBe(false);
    expect(contentTypeAcceptable('application/msword', undefined, 'a.doc')).toBe(false);
  });

  it('accepts a Compound File container as .doc only with a .doc file name', () => {
    expect(
      verifiedContentType({
        declared: 'application/msword',
        detected: 'application/x-cfb',
        fileName: 'Birth Certificate.DOC',
      }),
    ).toBe('application/msword');
    // Same container under another name (e.g. a renamed installer) is refused.
    expect(
      verifiedContentType({
        declared: 'application/msword',
        detected: 'application/x-cfb',
        fileName: 'letter.msi',
      }),
    ).toBeNull();
    // The equivalence is one-way: x-cfb is never a stand-in for other types.
    expect(contentTypeAcceptable('application/pdf', 'application/x-cfb', 'a.doc')).toBe(
      false,
    );
  });

  it('treats HEIC and HEIF as the same container', () => {
    expect(
      verifiedContentType({
        declared: 'image/heic',
        detected: 'image/heif',
        fileName: 'IMG_0001.HEIC',
      }),
    ).toBe('image/heif');
    expect(
      verifiedContentType({
        declared: 'image/heif',
        detected: 'image/heic',
        fileName: 'photo.heif',
      }),
    ).toBe('image/heic');
  });

  it('stores the detected type, not the declared one', () => {
    expect(
      verifiedContentType({
        declared: 'image/jpeg',
        detected: 'image/jpeg',
        fileName: 'scan.jpg',
      }),
    ).toBe('image/jpeg');
  });
});

describe('upload size verification', () => {
  it('requires the stored size to equal the declared size', () => {
    expect(uploadSizeAcceptable(1024, 1024)).toBe(true);
    expect(uploadSizeAcceptable(1024, 1025)).toBe(false);
    expect(uploadSizeAcceptable(1024, 1023)).toBe(false);
    expect(uploadSizeAcceptable(1024, undefined)).toBe(false);
  });

  it('never accepts more than the cap, even when declared', () => {
    expect(uploadSizeAcceptable(MAX_EVIDENCE_BYTES, MAX_EVIDENCE_BYTES)).toBe(true);
    expect(uploadSizeAcceptable(MAX_EVIDENCE_BYTES + 1, MAX_EVIDENCE_BYTES + 1)).toBe(
      false,
    );
  });
});

describe('client-side upload checks', () => {
  it('falls back to the extension when the browser reports no usable type', () => {
    expect(inferUploadContentType('IMG_0001.HEIC', '')).toBe('image/heic');
    expect(inferUploadContentType('letter.doc', 'application/octet-stream')).toBe(
      'application/msword',
    );
    expect(inferUploadContentType('scan.pdf', 'application/pdf')).toBe('application/pdf');
    expect(inferUploadContentType('setup.exe', '')).toBeUndefined();
    expect(inferUploadContentType('archive.zip', 'application/zip')).toBeUndefined();
  });

  it('explains type and size problems in plain language', () => {
    expect(uploadProblem({ name: 'scan.pdf', size: 1024, type: 'application/pdf' })).toBe(
      null,
    );
    expect(uploadProblem({ name: 'setup.exe', size: 1024, type: '' })).toMatch(
      /not a file type we accept/,
    );
    expect(
      uploadProblem({
        name: 'big.pdf',
        size: MAX_EVIDENCE_BYTES + 1,
        type: 'application/pdf',
      }),
    ).toMatch(/larger than 25 MB/);
    expect(
      uploadProblem({ name: 'empty.pdf', size: 0, type: 'application/pdf' }),
    ).toMatch(/is empty/);
  });

  it('offers every allow-listed type and extension to the file picker', () => {
    for (const type of ALLOWED_CONTENT_TYPES) expect(UPLOAD_ACCEPT).toContain(type);
    expect(UPLOAD_ACCEPT).toContain('.heic');
    expect(UPLOAD_ACCEPT).toContain('.doc');
  });
});
