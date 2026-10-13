import { describe, expect, it } from 'vitest';
import {
  COMPLAINT_ESCALATION_TEXT,
  RIGHTS_REQUEST_TYPES,
  STATUTORY_PERIODS,
  canTransition,
  daysRemaining,
  escalationTextFor,
  isOverdue,
  statutoryDueDate,
} from '@/domains/privacy/rules';
import { logRequestSchema, updateRequestSchema } from '@/domains/privacy/schemas';

const day = 24 * 60 * 60 * 1000;
const received = new Date(Date.UTC(2026, 9, 1, 9, 0, 0));
const client = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('statutory due dates', () => {
  it('gives every request type a period and a legal basis', () => {
    for (const type of RIGHTS_REQUEST_TYPES) {
      expect(STATUTORY_PERIODS[type].days).toBeGreaterThan(0);
      expect(STATUTORY_PERIODS[type].basis.length).toBeGreaterThan(0);
    }
  });

  it('dates access and correction 30 days from receipt (APP 12.4, 13.5)', () => {
    expect(statutoryDueDate('access', received).getTime()).toBe(
      received.getTime() + 30 * day,
    );
    expect(statutoryDueDate('correction', received).getTime()).toBe(
      received.getTime() + 30 * day,
    );
    expect(STATUTORY_PERIODS.access.basis).toMatch(/APP 12/);
    expect(STATUTORY_PERIODS.correction.basis).toMatch(/APP 13/);
  });

  it('counts down and flags overdue open requests only', () => {
    const dueAt = statutoryDueDate('access', received);
    const early = new Date(received.getTime() + 10 * day);
    const late = new Date(received.getTime() + 33 * day);
    expect(daysRemaining(dueAt, early)).toBe(20);
    expect(daysRemaining(dueAt, late)).toBe(-3);
    expect(isOverdue({ status: 'in_progress', dueAt }, early)).toBe(false);
    expect(isOverdue({ status: 'in_progress', dueAt }, late)).toBe(true);
    expect(isOverdue({ status: 'completed', dueAt }, late)).toBe(false);
  });
});

describe('request status transitions', () => {
  it('lets an open request move forward and close', () => {
    expect(canTransition('received', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
    expect(canTransition('in_progress', 'refused')).toBe(true);
  });

  it('never reopens a closed request', () => {
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('refused', 'received')).toBe(false);
    expect(canTransition('in_progress', 'received')).toBe(false);
  });
});

describe('complaint escalation', () => {
  it('names the OAIC and every state and territory regulator', () => {
    expect(COMPLAINT_ESCALATION_TEXT).toMatch(
      /Office of the Australian Information Commissioner/,
    );
    expect(COMPLAINT_ESCALATION_TEXT).toMatch(/oaic\.gov\.au/);
    for (const place of [
      'NSW',
      'Victoria',
      'Queensland',
      'Western Australia',
      'South Australia',
      'Tasmania',
      'Northern Territory',
      'ACT',
    ]) {
      expect(COMPLAINT_ESCALATION_TEXT).toContain(place);
    }
  });

  it('is attached to complaints only', () => {
    expect(escalationTextFor('complaint')).toBe(COMPLAINT_ESCALATION_TEXT);
    expect(escalationTextFor('access')).toBeNull();
    expect(escalationTextFor('erasure')).toBeNull();
  });
});

describe('request schemas', () => {
  it('requires a subject and a requester', () => {
    expect(() =>
      logRequestSchema.parse({ type: 'access', requesterName: 'A' }),
    ).toThrow();
    expect(
      logRequestSchema.parse({
        type: 'access',
        subjectClientId: client,
        requesterName: 'A',
      }),
    ).toMatchObject({ type: 'access', subjectClientId: client });
  });

  it('rejects a receipt date in the future', () => {
    expect(() =>
      logRequestSchema.parse({
        type: 'access',
        subjectClientId: client,
        requesterName: 'A',
        receivedAt: new Date(Date.now() + 2 * day),
      }),
    ).toThrow();
  });

  it('requires a reason to extend and reasons to refuse', () => {
    expect(() => updateRequestSchema.parse({ dueAt: new Date() })).toThrow();
    expect(
      updateRequestSchema.parse({ dueAt: new Date(), extensionReason: 'Complex search' }),
    ).toMatchObject({ extensionReason: 'Complex search' });
    expect(() => updateRequestSchema.parse({ status: 'refused' })).toThrow();
    expect(
      updateRequestSchema.parse({ status: 'refused', outcome: 'Exemption applies' }),
    ).toMatchObject({ status: 'refused' });
  });
});
