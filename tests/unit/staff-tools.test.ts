import { describe, expect, it } from 'vitest';
import { CONSENT_READ_PERMISSIONS } from '@/domains/consent/permissions';
import { parseApplicationImportLines } from '@/domains/imports/parse-lines';
import { REPRESENTATIVE_LIST_PERMISSIONS } from '@/domains/representatives/permissions';
import { STAFF_TOOL_LINKS, visibleStaffTools } from '@/lib/navigation/staff-tools';
import { permissionsForRole } from '@/lib/permissions/roles';

function labelsFor(slug: Parameters<typeof permissionsForRole>[0]): string[] {
  return visibleStaffTools(new Set(permissionsForRole(slug))).map((link) => link.label);
}

describe('staff tool navigation', () => {
  it('hides tools a role cannot use', () => {
    const admin = labelsFor('organisation-admin');
    expect(admin).toEqual(
      expect.arrayContaining(['Reports', 'API keys', 'Webhooks', 'Single sign-on']),
    );
    expect(admin).toContain('Audit trail');
    expect(admin).not.toContain('Retention');
    expect(admin).not.toContain('Imports');
    expect(admin).not.toContain('Consents');
    expect(admin).not.toContain('Representatives');

    const records = labelsFor('records-officer');
    expect(records).toEqual(expect.arrayContaining(['Reports', 'Retention']));
    expect(records).not.toContain('API keys');
    expect(records).not.toContain('Audit trail');

    const intake = labelsFor('intake-officer');
    expect(intake).toEqual(
      expect.arrayContaining(['Imports', 'Consents', 'Representatives']),
    );
    expect(intake).not.toContain('Webhooks');

    expect(labelsFor('applicant')).not.toContain('Representatives');
    expect(labelsFor('platform-operator')).toEqual([]);
    expect(visibleStaffTools(new Set())).toEqual([]);
  });

  it('uses the same permission lists as the services', () => {
    const consents = STAFF_TOOL_LINKS.find((link) => link.href === '/consents');
    const representatives = STAFF_TOOL_LINKS.find(
      (link) => link.href === '/representatives',
    );
    expect(consents?.anyOf).toEqual(CONSENT_READ_PERMISSIONS);
    expect(representatives?.anyOf).toEqual(REPRESENTATIVE_LIST_PERMISSIONS);
  });
});

describe('parseApplicationImportLines', () => {
  it('reads names, priorities, headers and comments', () => {
    const parsed = parseApplicationImportLines(
      ['# note', 'Name, Priority', 'Ada Smith, high', 'Bo Lee', ''].join('\n'),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { applicantName: 'Ada Smith', priority: 'high' },
      { applicantName: 'Bo Lee' },
    ]);
  });

  it('rejects a bad priority and a batch over 100', () => {
    const bad = parseApplicationImportLines('Ada, urgent');
    expect(bad.errors[0]?.message).toMatch(/low, normal or high/);

    const tooMany = parseApplicationImportLines(
      Array.from({ length: 101 }, (_, index) => `Person ${index}`).join('\n'),
    );
    expect(tooMany.errors.some((error) => error.message.includes('100'))).toBe(true);
  });
});
