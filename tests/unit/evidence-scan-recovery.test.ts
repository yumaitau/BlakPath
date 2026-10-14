import { describe, expect, it } from 'vitest';
import { EvidenceUploadIncompleteError } from '@/domains/evidence/errors';
import {
  pendingUploadExpired,
  quarantineBacklog,
  quarantineBacklogSignal,
  quarantineUploadProblem,
  quarantinedNeedsRequeue,
} from '@/domains/evidence/recovery';
import { isMissingObject } from '@/lib/storage/s3';

const NOW = new Date('2026-10-14T00:00:00.000Z');

describe('evidence scan recovery rules', () => {
  it('rejects a complete call when the quarantine object is missing or the wrong size', () => {
    expect(quarantineUploadProblem(100, null)).toBe('missing');
    expect(quarantineUploadProblem(100, { contentLength: 40 })).toBe('size-mismatch');
    expect(quarantineUploadProblem(100, { contentLength: 100 })).toBeNull();
    expect(new EvidenceUploadIncompleteError('missing').status).toBe(409);
  });

  it('re-queues only quarantined rows past the threshold with no in-flight scan', () => {
    const old = new Date(NOW.getTime() - 10 * 60 * 1000);
    const recent = new Date(NOW.getTime() - 10 * 60 * 1000 + 1);
    expect(
      quarantinedNeedsRequeue({
        updatedAt: old,
        now: NOW,
        requeueAfterMs: 600_000,
        inFlight: false,
      }),
    ).toBe(true);
    expect(
      quarantinedNeedsRequeue({
        updatedAt: recent,
        now: NOW,
        requeueAfterMs: 600_000,
        inFlight: false,
      }),
    ).toBe(false);
    expect(
      quarantinedNeedsRequeue({
        updatedAt: old,
        now: NOW,
        requeueAfterMs: 600_000,
        inFlight: true,
      }),
    ).toBe(false);
  });

  it('expires a pending upload after 24 hours and not before', () => {
    expect(
      pendingUploadExpired(new Date(NOW.getTime() - 86_400_000), NOW, 86_400_000),
    ).toBe(true);
    expect(
      pendingUploadExpired(new Date(NOW.getTime() - 86_400_000 + 1), NOW, 86_400_000),
    ).toBe(false);
  });

  it('reports oldest quarantined age and pages at the 30 minute handling target', () => {
    expect(quarantineBacklog([], NOW)).toEqual({
      quarantinedCount: 0,
      oldestQuarantinedAgeSeconds: 0,
    });
    const signal = quarantineBacklogSignal({
      backlog: quarantineBacklog([new Date(NOW.getTime() - 1_800_000)], NOW),
      alarmAfterSeconds: 1_800,
      dlqDepth: 0,
      redriven: 2,
    });
    expect(signal).toMatchObject({
      signal: 'evidence_quarantine_backlog',
      alert: true,
      quarantinedCount: 1,
      oldestQuarantinedAgeSeconds: 1_800,
      dlqDepth: 0,
      redriven: 2,
    });
    expect(
      quarantineBacklogSignal({
        backlog: quarantineBacklog([new Date(NOW.getTime() - 1_799_000)], NOW),
        alarmAfterSeconds: 1_800,
        dlqDepth: 0,
        redriven: 0,
      }).alert,
    ).toBe(false);
  });

  it('treats S3 not-found names and HTTP 404 as a missing object', () => {
    expect(isMissingObject(Object.assign(new Error('gone'), { name: 'NotFound' }))).toBe(
      true,
    );
    expect(isMissingObject(Object.assign(new Error('gone'), { name: 'NoSuchKey' }))).toBe(
      true,
    );
    expect(isMissingObject({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(
      isMissingObject(Object.assign(new Error('down'), { name: 'NetworkingError' })),
    ).toBe(false);
    expect(isMissingObject(null)).toBe(false);
  });
});
