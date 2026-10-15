import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  BREAK_GLASS_REVIEW_TIME_ZONE,
  BREAK_GLASS_STATUSES,
  canActivate,
  canApprove,
  canDeny,
  canReview,
  canRevoke,
  isLive,
  isReviewOverdue,
  isTerminal,
} from '@/domains/break-glass/status';
import {
  denyBreakGlassSchema,
  requestBreakGlassSchema,
  reviewBreakGlassSchema,
} from '@/domains/break-glass/schemas';
import { stampBreakGlassMeta } from '@/domains/audit/break-glass-flag';
import { BreakGlassWriteError } from '@/lib/tenancy/break-glass-write';
import { readOnlyDatabase } from '@/lib/tenancy/read-only-db';
import type { Database } from '@/db/client';
import { assertDifferentActor } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';

describe('break-glass state machine', () => {
  it('gates each transition to the right prior state', () => {
    expect(canApprove('requested')).toBe(true);
    expect(canDeny('requested')).toBe(true);
    expect(canApprove('approved')).toBe(false);
    expect(canActivate('approved')).toBe(true);
    expect(canActivate('requested')).toBe(false);
    expect(canRevoke('approved')).toBe(true);
    expect(canRevoke('active')).toBe(true);
    expect(canRevoke('denied')).toBe(false);
  });

  it('marks denied/expired/revoked terminal', () => {
    for (const s of ['denied', 'expired', 'revoked'] as const) {
      expect(isTerminal(s)).toBe(true);
    }
    for (const s of ['requested', 'approved', 'active'] as const) {
      expect(isTerminal(s)).toBe(false);
    }
  });

  it('isLive requires active AND unexpired', () => {
    const now = new Date(Date.UTC(2026, 6, 1));
    const future = new Date(now.getTime() + 60_000);
    const past = new Date(now.getTime() - 60_000);
    expect(isLive('active', future, now)).toBe(true);
    expect(isLive('active', past, now)).toBe(false);
    expect(isLive('active', null, now)).toBe(true);
    expect(isLive('approved', future, now)).toBe(false);
  });

  it('lists every status', () => {
    expect([...BREAK_GLASS_STATUSES]).toEqual([
      'requested',
      'approved',
      'denied',
      'active',
      'expired',
      'revoked',
    ]);
  });
});

describe('separation of duties (approver != requester)', () => {
  it('rejects the requester approving their own grant', () => {
    expect(() => assertDifferentActor('op-1', 'approver-2')).not.toThrow();
    expect(() => assertDifferentActor('op-1', 'op-1')).toThrow(AuthorizationError);
  });
});

describe('break-glass schemas', () => {
  it('validates a request and enforces expiry bounds', () => {
    const base = {
      organisationId: '018f5b3a-0000-7000-8000-000000000000',
      supportCaseRef: 'SUP-123',
      purpose: 'Investigate a stuck upload',
      scope: 'read the applicant’s evidence metadata',
    };
    expect(requestBreakGlassSchema.safeParse(base).success).toBe(true);
    expect(requestBreakGlassSchema.parse(base).expiresInMinutes).toBe(60);
    expect(
      requestBreakGlassSchema.safeParse({ ...base, expiresInMinutes: 999 }).success,
    ).toBe(false);
    expect(
      requestBreakGlassSchema.safeParse({ ...base, organisationId: 'x' }).success,
    ).toBe(false);
    expect(denyBreakGlassSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(reviewBreakGlassSchema.safeParse({ notes: 'Matched the case.' }).success).toBe(
      true,
    );
    expect(reviewBreakGlassSchema.safeParse({ notes: '   ' }).success).toBe(false);
  });
});

function sydneyDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BREAK_GLASS_REVIEW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function sydneyTime(instant: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: BREAK_GLASS_REVIEW_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

describe('break-glass review deadline', () => {
  it('allows review only after access has started', () => {
    expect(canReview('active')).toBe(true);
    expect(canReview('expired')).toBe(true);
    expect(canReview('revoked')).toBe(true);
    expect(canReview('approved')).toBe(false);
    expect(canReview('requested')).toBe(false);
  });

  it('adds weekdays in Australia/Sydney and keeps the local time', () => {
    const friday = new Date('2026-10-16T04:00:00.000Z');
    expect(sydneyDate(addBusinessDays(friday, 1))).toBe('2026-10-19');
    expect(sydneyDate(addBusinessDays(friday, 5))).toBe('2026-10-23');
    expect(sydneyTime(addBusinessDays(friday, 5))).toBe('15:00');

    const monday = new Date('2026-10-12T04:00:00.000Z');
    expect(sydneyDate(addBusinessDays(monday, 5))).toBe('2026-10-19');

    const beforeDst = new Date('2026-10-02T05:00:00.000Z');
    const landed = addBusinessDays(beforeDst, 1);
    expect(sydneyDate(landed)).toBe('2026-10-05');
    expect(sydneyTime(landed)).toBe('15:00');
  });

  it('marks an unreviewed used grant overdue only after the due instant', () => {
    const due = new Date('2026-10-23T04:00:00.000Z');
    const before = new Date(due.getTime() - 1);
    expect(isReviewOverdue('active', due, null, before)).toBe(false);
    expect(isReviewOverdue('expired', due, null, due)).toBe(false);
    expect(isReviewOverdue('revoked', due, null, new Date(due.getTime() + 1))).toBe(true);
    expect(isReviewOverdue('expired', due, new Date(), new Date(due.getTime() + 1))).toBe(
      false,
    );
    expect(isReviewOverdue('approved', due, null, new Date(due.getTime() + 1))).toBe(
      false,
    );
    expect(isReviewOverdue('active', null, null, due)).toBe(false);
  });
});

describe('break-glass audit flag and read-only handle', () => {
  it('stamps the flag into afterMeta without dropping existing keys', () => {
    expect(stampBreakGlassMeta(null, undefined)).toBeNull();
    expect(stampBreakGlassMeta({ status: 'active' }, undefined)).toEqual({
      status: 'active',
    });
    expect(stampBreakGlassMeta({ status: 'active' }, { requestId: 'grant-1' })).toEqual({
      status: 'active',
      breakGlass: true,
      breakGlassRequestId: 'grant-1',
    });
  });

  it('rejects writes on the break-glass database handle', () => {
    const database = {
      select: () => 'selected',
      insert: () => 'inserted',
      update: () => 'updated',
      delete: () => 'deleted',
      execute: () => 'executed',
      transaction: () => 'transacted',
    };
    const guarded = readOnlyDatabase(database as unknown as Database) as unknown as {
      select: () => string;
      insert: () => void;
      update: () => void;
      delete: () => void;
      execute: () => void;
      transaction: () => void;
    };
    expect(guarded.select()).toBe('selected');
    expect(() => guarded.insert()).toThrow(BreakGlassWriteError);
    expect(() => guarded.update()).toThrow(BreakGlassWriteError);
    expect(() => guarded.delete()).toThrow(BreakGlassWriteError);
    expect(() => guarded.execute()).toThrow(BreakGlassWriteError);
    expect(() => guarded.transaction()).toThrow(BreakGlassWriteError);
  });
});
