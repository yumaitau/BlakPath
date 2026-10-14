import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_CSV_HEADERS,
  AUDIT_MONTHLY_REVIEW_CHECKS,
  BREAK_GLASS_ACTION_LIKE,
  auditEventsToCsv,
  auditLogQuerySchema,
  recordMonthlyReviewSchema,
  tenantAuditWhere,
} from '@/domains/audit';
import { isPermission } from '@/lib/permissions/catalog';
import { permissionsForRole } from '@/lib/permissions/roles';

const dialect = new PgDialect();
const CASE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function sqlOf(organisationId: string, raw: unknown) {
  return dialect.sqlToQuery(
    tenantAuditWhere(organisationId, auditLogQuerySchema.parse(raw)),
  );
}

describe('audit log filters', () => {
  it('always constrains the tenant and never trusts an organisation id in the query', () => {
    const evil = "'; drop table audit_events; --";
    const query = sqlOf(evil, { organisationId: CASE_ID, denials: '1' });
    expect(query.sql).not.toContain(evil);
    expect(query.sql.match(/organisation_id/g)).toEqual(['organisation_id']);
    expect(query.params).toContain(evil);
    expect(query.params).toContain('denied');
    expect(query.params).not.toContain(CASE_ID);

    const parsed = auditLogQuerySchema.parse({ organisationId: CASE_ID });
    expect(Object.hasOwn(parsed, 'organisationId')).toBe(false);
  });

  it('filters case, user, action, dates, break-glass and denials', () => {
    const query = sqlOf('org-1', {
      case: CASE_ID,
      user: USER_ID,
      action: 'application.viewed',
      from: '2026-10-01',
      to: '2026-10-31',
      breakGlass: '1',
      denials: 'true',
    });
    expect(query.params).toContain('org-1');
    expect(query.params).toContain(CASE_ID);
    expect(query.params).toContain(USER_ID);
    expect(query.params).toContain('application.viewed');
    expect(query.params).toContain(BREAK_GLASS_ACTION_LIKE);
    expect(query.params).toContain('break_glass_request');
    expect(query.params).toContain('denied');
    expect(query.sql).toContain('applicationId');
    expect(query.sql.match(/organisation_id/g)).toEqual(['organisation_id']);

    const parsed = auditLogQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31' });
    expect(parsed.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(parsed.to?.toISOString()).toBe('2026-10-31T23:59:59.999Z');
    expect(
      auditLogQuerySchema.parse({ to: '2026-10-31T01:02:03.000Z' }).to?.toISOString(),
    ).toBe('2026-10-31T01:02:03.000Z');
  });

  it('rejects inverted dates, bad ids and oversized pages', () => {
    expect(
      auditLogQuerySchema.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success,
    ).toBe(false);
    expect(auditLogQuerySchema.safeParse({ case: 'not-a-case' }).success).toBe(false);
    expect(auditLogQuerySchema.safeParse({ action: 'Application Viewed' }).success).toBe(
      false,
    );
    expect(auditLogQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(recordMonthlyReviewSchema.safeParse({ period: '2026-13' }).success).toBe(
      false,
    );
    expect(
      recordMonthlyReviewSchema.safeParse({ period: '2026-10', notes: 'ok' }).success,
    ).toBe(true);
  });
});

describe('audit csv', () => {
  it('neutralises formula prefixes and still quotes ordinary commas', () => {
    const csv = auditEventsToCsv([
      {
        id: '1',
        timestamp: '2026-01-02T03:04:05.000Z',
        actorUserId: null,
        actorName: '=1+1',
        actingRole: '-2',
        action: 'application.viewed',
        resourceType: 'application',
        resourceId: '+1',
        result: 'success',
        reason: 'Smith, Ada',
        ipAddress: '@cmd',
        correlationId: null,
        beforeMeta: null,
        afterMeta: { applicationId: CASE_ID },
      },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(AUDIT_CSV_HEADERS.join(','));
    expect(lines[1]).toContain("'=1+1");
    expect(lines[1]).toContain("'+1");
    expect(lines[1]).toContain("'@cmd");
    expect(lines[1]).toContain("'-2");
    expect(lines[1]).toContain('"Smith, Ada"');
    expect(lines[1]).not.toMatch(/(^|,)=1\+1/);
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('audit permission names', () => {
  it('uses audit:view in the catalogue, the org-admin role and the docs', () => {
    expect(isPermission('audit:view')).toBe(true);
    expect(isPermission('audit:read')).toBe(false);
    expect(isPermission('audit:verify')).toBe(false);
    expect(permissionsForRole('organisation-admin')).toContain('audit:view');

    const docs = [
      'docs/audit-log-design.md',
      'docs/authorization-matrix.md',
      'docs/audit-monthly-review.md',
      'README.md',
    ].map((path) => readFileSync(path, 'utf8'));
    for (const text of docs) {
      expect(text).not.toMatch(/audit:(read|verify)\b/);
    }
    expect(docs[0]).toContain('`audit:view`');
    expect(docs[1]).toContain('`audit:view`');
  });

  it('keeps the monthly checklist in the doc', () => {
    const text = readFileSync('docs/audit-monthly-review.md', 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(AUDIT_MONTHLY_REVIEW_CHECKS.length).toBeGreaterThanOrEqual(8);
    for (const check of AUDIT_MONTHLY_REVIEW_CHECKS) {
      expect(text).toContain(check.title);
      expect(text).toContain(check.body.replace(/\s+/g, ' '));
      expect(check.body).not.toMatch(/score|rank|predict|auto-approve|auto-reject/i);
    }
  });
});
