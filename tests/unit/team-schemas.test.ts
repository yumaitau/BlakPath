import { describe, expect, it } from 'vitest';
import {
  addGroupMemberSchema,
  addTeamMemberSchema,
  removeGroupMemberSchema,
  removeTeamMemberSchema,
} from '@/domains/teams/schemas';

const TEAM = '018f5b3a-0000-7000-8000-000000000001';
const GROUP = '018f5b3a-0000-7000-8000-000000000002';
const USER = '018f5b3a-0000-7000-8000-000000000003';

describe('team membership schemas', () => {
  it('accepts a team member add and remove', () => {
    expect(addTeamMemberSchema.safeParse({ teamId: TEAM, userId: USER }).success).toBe(
      true,
    );
    expect(
      addTeamMemberSchema.safeParse({ teamId: TEAM, userId: USER, role: 'lead' }).success,
    ).toBe(true);
    expect(
      addTeamMemberSchema.safeParse({ teamId: TEAM, userId: USER, role: 'admin' })
        .success,
    ).toBe(false);
    expect(removeTeamMemberSchema.safeParse({ teamId: TEAM, userId: USER }).success).toBe(
      true,
    );
    expect(
      removeTeamMemberSchema.safeParse({ teamId: 'nope', userId: USER }).success,
    ).toBe(false);
  });

  it('accepts a group member add and remove', () => {
    expect(addGroupMemberSchema.safeParse({ groupId: GROUP, userId: USER }).success).toBe(
      true,
    );
    expect(
      removeGroupMemberSchema.safeParse({ groupId: GROUP, userId: USER }).success,
    ).toBe(true);
    expect(removeGroupMemberSchema.safeParse({ groupId: GROUP }).success).toBe(false);
  });
});
