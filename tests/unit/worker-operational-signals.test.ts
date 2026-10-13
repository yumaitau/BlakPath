import { describe, expect, it } from 'vitest';
import {
  auditIntegrityFailureSignal,
  queueFailureSignal,
} from '../../worker/operational-signals';

describe('worker operational signals', () => {
  it('marks retryable failures without paging', () => {
    expect(queueFailureSignal({ attemptsMade: 2, opts: { attempts: 5 } })).toEqual({
      signal: 'queue_job_failure',
      alert: false,
      attemptsMade: 2,
      maxAttempts: 5,
    });
  });

  it('emits the audit-integrity metric signal without event content', () => {
    expect(
      auditIntegrityFailureSignal({
        chain: 'platform',
        organisationId: null,
        eventId: 'evt-1',
        index: 2,
        reason: 'hash_mismatch',
        eventCount: 3,
      }),
    ).toEqual({
      signal: 'audit_integrity_failure',
      alert: true,
      metric: 'AuditIntegrityFailures',
      chain: 'platform',
      organisationId: null,
      eventId: 'evt-1',
      index: 2,
      reason: 'hash_mismatch',
      eventCount: 3,
    });
  });

  it('marks the final failure as an actionable exhausted-job signal', () => {
    expect(queueFailureSignal({ attemptsMade: 5, opts: { attempts: 5 } })).toEqual({
      signal: 'queue_job_exhausted',
      alert: true,
      attemptsMade: 5,
      maxAttempts: 5,
    });
  });
});
