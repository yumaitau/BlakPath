import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSION_SEED,
  isPermission,
  type Permission,
} from '@/lib/permissions/catalog';
import {
  SYSTEM_ROLES,
  SYSTEM_ROLE_SEED,
  isSystemRoleSlug,
  permissionsForRole,
} from '@/lib/permissions/roles';
import {
  assertDifferentActor,
  assertNotConflicted,
  every,
  hasAll,
  hasAny,
  hasPermission,
  requirePermission,
  requirePolicy,
  requiring,
  some,
  type Policy,
  type Subject,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';

/** Build a subject holding exactly the given permission keys. */
function subjectWith(...keys: Permission[]): Subject {
  return { userId: 'user-1', permissions: new Set<string>(keys) };
}

describe('permission catalogue', () => {
  it('is frozen and internally consistent', () => {
    expect(Object.isFrozen(PERMISSION_CATALOG)).toBe(true);
    for (const key of ALL_PERMISSIONS) {
      const def = PERMISSION_CATALOG[key];
      expect(def.key).toBe(key);
      expect(def.description.length).toBeGreaterThan(0);
    }
    expect(PERMISSION_SEED.length).toBe(ALL_PERMISSIONS.length);
  });

  it('contains every spec permission key and nothing that scores a person', () => {
    const expected = [
      'application:create',
      'application:read-own',
      'application:read-assigned',
      'application:read-any',
      'application:update-intake',
      'application:assign',
      'evidence:upload-own',
      'evidence:read-assigned',
      'evidence:classify',
      'evidence:download',
      'evidence:request',
      'family-link:request',
      'family-link:approve',
      'review:create',
      'review:finalise',
      'meeting:create',
      'meeting:agenda-manage',
      'meeting:pack-access',
      'conflict:declare',
      'decision:propose',
      'decision:vote',
      'decision:finalise',
      'certificate:generate',
      'certificate:sign',
      'certificate:revoke',
      'report:view',
      'report:export',
      'audit:view',
      'retention:manage',
      'tenant:configure',
      'membership:manage',
      'break-glass:request',
      'break-glass:approve',
      'team:create',
      'team:manage',
      'group:create',
      'group:manage',
      'client:create',
      'client:read-assigned',
      'client:read-any',
      'client:assign-team',
      'calendar:create',
      'calendar:read-any',
      'calendar:update-any',
      'calendar:delete-any',
    ];
    expect([...ALL_PERMISSIONS].sort()).toEqual([...expected].sort());
    // No determination/scoring capability may ever exist.
    for (const key of ALL_PERMISSIONS) {
      expect(key).not.toMatch(/score|rank|predict|auto|determine/i);
    }
  });

  it('isPermission narrows correctly', () => {
    expect(isPermission('application:create')).toBe(true);
    expect(isPermission('application:delete-everything')).toBe(false);
  });
});

describe('system role templates', () => {
  it('only ever grant catalogued permissions', () => {
    for (const role of SYSTEM_ROLE_SEED) {
      for (const key of role.permissions) {
        expect(isPermission(key)).toBe(true);
      }
    }
  });

  it('map the expected slugs', () => {
    expect(isSystemRoleSlug('committee-chair')).toBe(true);
    expect(isSystemRoleSlug('overlord')).toBe(false);
    expect(permissionsForRole('applicant')).toContain('application:read-own');
  });

  describe('separation of duties', () => {
    it('organisation-admin holds no evidence, decision or certificate power', () => {
      const admin = SYSTEM_ROLES['organisation-admin'].permissions;
      for (const key of admin) {
        expect(key.startsWith('evidence:')).toBe(false);
        expect(key.startsWith('decision:')).toBe(false);
        expect(key.startsWith('certificate:')).toBe(false);
      }
      expect(admin).toContain('membership:manage');
      expect(admin).toContain('break-glass:approve');
    });

    it('case-officer cannot finalise decisions or sign certificates', () => {
      const officer = SYSTEM_ROLES['case-officer'].permissions;
      expect(officer).not.toContain('decision:finalise');
      expect(officer).not.toContain('certificate:sign');
      expect(officer).toContain('review:finalise');
    });

    it('committee-member votes and reads packs but cannot sign certificates', () => {
      const member = SYSTEM_ROLES['committee-member'].permissions;
      expect(member).toContain('meeting:pack-access');
      expect(member).toContain('decision:vote');
      expect(member).not.toContain('certificate:sign');
      expect(member).not.toContain('decision:finalise');
    });

    it('committee-chair may finalise and sign', () => {
      const chair = SYSTEM_ROLES['committee-chair'].permissions;
      expect(chair).toContain('decision:finalise');
      expect(chair).toContain('certificate:sign');
    });

    it('platform-operator holds no tenant data permissions', () => {
      const op = SYSTEM_ROLES['platform-operator'].permissions;
      expect(op).toEqual(['break-glass:request']);
    });
  });
});

describe('capability checks', () => {
  const subject = subjectWith('application:read-any', 'decision:vote');

  it('hasPermission / hasAny / hasAll', () => {
    expect(hasPermission(subject, 'application:read-any')).toBe(true);
    expect(hasPermission(subject, 'certificate:sign')).toBe(false);
    expect(hasAny(subject, ['certificate:sign', 'decision:vote'])).toBe(true);
    expect(hasAny(subject, ['certificate:sign'])).toBe(false);
    expect(hasAll(subject, ['application:read-any', 'decision:vote'])).toBe(true);
    expect(hasAll(subject, ['application:read-any', 'certificate:sign'])).toBe(false);
  });

  it('requirePermission throws a non-leaking AuthorizationError on denial', () => {
    expect(() => requirePermission(subject, 'certificate:sign')).toThrow(
      AuthorizationError,
    );
    try {
      requirePermission(subject, 'certificate:sign');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.code).toBe('PERMISSION_DENIED');
      // Message must not leak the resource/permission that was checked.
      expect(authError.message).not.toContain('certificate');
    }
    expect(() => requirePermission(subject, 'application:read-any')).not.toThrow();
  });
});

describe('separation-of-duties guards', () => {
  it('assertDifferentActor rejects the same actor and missing counterparties', () => {
    expect(() => assertDifferentActor('a', 'b')).not.toThrow();
    expect(() => assertDifferentActor('a', 'a')).toThrow(AuthorizationError);
    expect(() => assertDifferentActor('a', null)).toThrow(AuthorizationError);
    expect(() => assertDifferentActor('a', undefined)).toThrow(AuthorizationError);
    try {
      assertDifferentActor('a', 'a');
    } catch (error) {
      expect((error as AuthorizationError).code).toBe('SEPARATION_OF_DUTIES');
    }
  });

  it('assertNotConflicted blocks a conflicted actor (set or array)', () => {
    expect(() => assertNotConflicted('a', new Set(['b']))).not.toThrow();
    expect(() => assertNotConflicted('a', new Set(['a']))).toThrow(AuthorizationError);
    expect(() => assertNotConflicted('a', ['a', 'c'])).toThrow(AuthorizationError);
    try {
      assertNotConflicted('a', ['a']);
    } catch (error) {
      expect((error as AuthorizationError).code).toBe('CONFLICT_OF_INTEREST');
    }
  });
});

describe('contextual policies', () => {
  interface App {
    assignedTo: string | null;
  }

  const assignedToActor: Policy<App> = (subject, app) =>
    app.assignedTo === subject.userId;

  const subject = subjectWith('application:read-assigned');

  it('requiring gates a policy behind a capability', () => {
    const policy = requiring<App>('application:read-assigned', assignedToActor);
    expect(policy(subject, { assignedTo: 'user-1' })).toBe(true);
    expect(policy(subject, { assignedTo: 'user-2' })).toBe(false);
    // Without the capability the policy denies even when assigned.
    const noCap = subjectWith();
    expect(policy(noCap, { assignedTo: 'user-1' })).toBe(false);
  });

  it('every / some combinators compose', () => {
    const always: Policy<App> = () => true;
    const never: Policy<App> = () => false;
    expect(every(always, always)(subject, { assignedTo: null })).toBe(true);
    expect(every(always, never)(subject, { assignedTo: null })).toBe(false);
    expect(some(never, always)(subject, { assignedTo: null })).toBe(true);
    expect(some(never, never)(subject, { assignedTo: null })).toBe(false);
  });

  it('requirePolicy throws POLICY_DENIED on denial', () => {
    const policy = requiring<App>('application:read-assigned', assignedToActor);
    expect(() => requirePolicy(policy, subject, { assignedTo: 'user-1' })).not.toThrow();
    expect(() => requirePolicy(policy, subject, { assignedTo: 'user-2' })).toThrow(
      AuthorizationError,
    );
    try {
      requirePolicy(policy, subject, { assignedTo: 'user-2' });
    } catch (error) {
      expect((error as AuthorizationError).code).toBe('POLICY_DENIED');
    }
  });
});
