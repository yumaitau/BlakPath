import { describe, expect, it } from 'vitest';
import {
  canReadApplication,
  canReadTeamApplication,
} from '@/domains/applications/policies';
import type { Subject } from '@/lib/permissions/check';

function subjectWith(...keys: string[]): Subject {
  return { userId: 'user-1', permissions: new Set(keys) };
}

describe('team application reads', () => {
  it('admits a team member holding read-assigned', () => {
    const subject = subjectWith('application:read-assigned');
    expect(
      canReadTeamApplication(subject, {
        applicantUserId: null,
        assigneeUserIds: [],
        teamMemberUserIds: ['user-1', 'user-2'],
      }),
    ).toBe(true);
  });

  it('denies non-members and the permission-less', () => {
    expect(
      canReadTeamApplication(subjectWith('application:read-assigned'), {
        applicantUserId: null,
        assigneeUserIds: [],
        teamMemberUserIds: ['user-9'],
      }),
    ).toBe(false);
    expect(
      canReadTeamApplication(subjectWith('application:read-own'), {
        applicantUserId: null,
        assigneeUserIds: [],
        teamMemberUserIds: ['user-1'],
      }),
    ).toBe(false);
  });

  it('composes into the full read policy without widening read-any', () => {
    const teamOnly = subjectWith('application:read-assigned');
    expect(
      canReadApplication(teamOnly, {
        applicantUserId: null,
        assigneeUserIds: [],
        teamMemberUserIds: ['user-1'],
      }),
    ).toBe(true);
    expect(
      canReadApplication(teamOnly, {
        applicantUserId: null,
        assigneeUserIds: [],
        teamMemberUserIds: [],
      }),
    ).toBe(false);
  });
});
