import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/queues', () => ({ QueueName: { Privacy: 'privacy' }, addJob: vi.fn() }));

import * as schema from '@/db/schema';
import {
  DATA_REGISTRY,
  ERASED_TEXT,
  SUBJECT_TABLES,
  isCorrectable,
} from '@/domains/privacy/registry';
import { SUBJECT_TARGETS, tableName } from '@/domains/privacy/subject';
import { erasureSet } from '@/domains/privacy/erasure';

const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable =>
  is(v, PgTable),
);
const configs = new Map(tables.map((t) => [getTableConfig(t).name, getTableConfig(t)]));

/** Text and JSON columns: where free-form personal information can live. */
function textualColumns(name: string): string[] {
  const config = configs.get(name)!;
  return config.columns
    .filter(
      (c) =>
        ['text', 'jsonb', 'json'].includes(c.getSQLType()) ||
        /^varchar/.test(c.getSQLType()),
    )
    .map((c) => c.name)
    .sort();
}

describe('personal-information registry', () => {
  it('classifies every table in the schema, and nothing else', () => {
    expect(Object.keys(DATA_REGISTRY).sort()).toEqual([...configs.keys()].sort());
  });

  it('names every text and JSON column of every table exactly once', () => {
    for (const [name, policy] of Object.entries(DATA_REGISTRY)) {
      const personal =
        policy.class === 'subject'
          ? Object.keys(policy.erase).filter((c) => textualColumns(name).includes(c))
          : [...policy.personal];
      const listed = [...personal, ...policy.other];
      expect(new Set(listed).size, `${name} lists a column twice`).toBe(listed.length);
      expect(listed.sort(), `${name} has unclassified or unknown columns`).toEqual(
        textualColumns(name),
      );
    }
  });

  it('erasure rules only name real columns, and never null a NOT NULL column', () => {
    for (const name of SUBJECT_TABLES) {
      const policy = DATA_REGISTRY[name]!;
      if (policy.class !== 'subject') throw new Error('unreachable');
      const columns = new Map(configs.get(name)!.columns.map((c) => [c.name, c]));
      for (const [column, rule] of Object.entries(policy.erase)) {
        const col = columns.get(column);
        expect(col, `${name}.${column}`).toBeDefined();
        if (rule.anonymise === 'null')
          expect(col!.notNull, `${name}.${column}`).toBe(false);
        if (rule.anonymise === 'redact') expect(col!.dataType).toBe('string');
        if (rule.anonymise === 'empty-object') expect(col!.dataType).toBe('json');
      }
    }
  });

  it('erasure anonymises every PII column outside official records (enumerated)', () => {
    const erased = Object.fromEntries(
      SUBJECT_TABLES.map((name) => {
        const policy = DATA_REGISTRY[name]!;
        return [name, policy.class === 'subject' ? Object.keys(policy.erase).sort() : []];
      }),
    );
    expect(erased).toEqual({
      clients: [
        'contact_email',
        'contact_phone',
        'display_name',
        'linked_user_id',
        'notes',
      ],
      applications: ['applicant_name', 'applicant_user_id', 'intake', 'withdrawn_reason'],
      application_notes: ['body'],
      application_status_history: ['note'],
      evidence: ['evidence_key', 'file_name', 'quarantine_key', 'sha256'],
      evidence_requests: ['description'],
      family_links: [
        'community',
        'decision_note',
        'notes',
        'relationship',
        'relative_name',
      ],
      form_invitations: ['recipient_email', 'recipient_name'],
      form_responses: ['answers', 'ip_address', 'respondent_email', 'respondent_name'],
      consent_records: ['notes'],
      representative_authorisations: [],
      reviews: ['content'],
      review_comments: ['body'],
      meeting_agenda_items: ['notes'],
      tasks: ['description', 'title'],
      notifications: ['body', 'title'],
      associated_statements: ['statement'],
    });
  });

  it('keeps personal columns only in official records, staff, configuration or platform tables', () => {
    const retainedOutsideSubject = Object.entries(DATA_REGISTRY)
      .filter(([, p]) => p.class !== 'subject' && p.personal.length > 0)
      .map(([name, p]) => `${p.class}:${name}`)
      .sort();
    expect(retainedOutsideSubject).toEqual([
      'official:audit_events',
      'official:certificates',
      'official:conflict_declarations',
      'official:decision_votes',
      'official:decisions',
      'official:legal_holds',
      'official:rights_requests',
      'platform:passkeys',
      'platform:sessions',
      'platform:users',
      'platform:verifications',
      'staff:calendar_event_attendees',
      'staff:calendar_events',
      'staff:meetings',
      'staff:membership_invitations',
    ]);
  });

  it('keeps only the official-record fields of decided or certified matters', () => {
    const official = SUBJECT_TABLES.flatMap((name) => {
      const policy = DATA_REGISTRY[name]!;
      if (policy.class !== 'subject') return [];
      return Object.entries(policy.erase)
        .filter(([, rule]) => rule.officialRecord)
        .map(([column]) => `${name}.${column}`);
    });
    expect(official.sort()).toEqual([
      'applications.applicant_name',
      'review_comments.body',
      'reviews.content',
    ]);
  });

  it('allows correction of contact, name and intake fields only', () => {
    expect(isCorrectable('applications', 'applicant_name')).toBe(true);
    expect(isCorrectable('applications', 'intake')).toBe(true);
    expect(isCorrectable('clients', 'contact_email')).toBe(true);
    expect(isCorrectable('applications', 'reference')).toBe(false);
    expect(isCorrectable('decisions', 'rationale')).toBe(false);
    expect(isCorrectable('audit_events', 'reason')).toBe(false);
  });
});

describe('subject targets', () => {
  it('has exactly one target per subject table, on the right table', () => {
    expect(Object.keys(SUBJECT_TARGETS).sort()).toEqual([...SUBJECT_TABLES].sort());
    for (const [name, target] of Object.entries(SUBJECT_TARGETS)) {
      expect(tableName(target.table)).toBe(name);
    }
  });

  it('builds the erasure SET from the registry, keeping official fields when asked', () => {
    const full = erasureSet(
      schema.applications,
      (
        DATA_REGISTRY.applications as never as {
          erase: Parameters<typeof erasureSet>[1];
        }
      ).erase,
      { keepOfficial: false },
    );
    expect(full).toEqual({
      applicantName: ERASED_TEXT,
      intake: null,
      withdrawnReason: null,
      applicantUserId: null,
    });
    const kept = erasureSet(
      schema.applications,
      (
        DATA_REGISTRY.applications as never as {
          erase: Parameters<typeof erasureSet>[1];
        }
      ).erase,
      { keepOfficial: true },
    );
    expect(kept).not.toHaveProperty('applicantName');
    expect(kept).toHaveProperty('intake', null);
  });

  it('writes an empty object over form answers', () => {
    const set = erasureSet(
      schema.formResponses,
      (
        DATA_REGISTRY.form_responses as never as {
          erase: Parameters<typeof erasureSet>[1];
        }
      ).erase,
      { keepOfficial: false },
    );
    expect(set.answers).toEqual({});
    expect(set.ipAddress).toBeNull();
  });
});
