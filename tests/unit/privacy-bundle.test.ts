import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client', () => ({ db: {} }));

import {
  BUNDLE_EXCLUSIONS,
  BUNDLE_TABLES,
  REDACTED,
  applyRedactions,
  type SubjectBundle,
} from '@/domains/privacy/bundle';
import { labelFor, renderBundlePdf, wrapText } from '@/domains/privacy/bundle-pdf';
import { SUBJECT_TABLES } from '@/domains/privacy/registry';

function bundle(records = 1): SubjectBundle {
  return {
    requestId: 'req-1',
    organisationName: 'Example Aboriginal Corporation',
    generatedAt: '2026-10-14T00:00:00.000Z',
    sections: [
      {
        table: 'applications',
        title: 'Applications',
        records: Array.from({ length: records }, (_, i) => ({
          id: `app-${i}`,
          fields: {
            reference: `APP-2026-${i}`,
            applicantName: 'Ngāti Example 🌿',
            intake: JSON.stringify({ phone: '0400 000 000' }),
          },
        })),
      },
      {
        table: 'family_links',
        title: 'Family connections',
        records: [
          {
            id: 'fl-1',
            fields: { relationship: 'grandmother', relativeName: 'Aunty X', notes: null },
          },
        ],
      },
    ],
  };
}

describe('subject bundle coverage', () => {
  it('covers the tables the access right needs', () => {
    expect(BUNDLE_TABLES).toEqual([
      'clients',
      'users',
      'applications',
      'application_status_history',
      'evidence',
      'evidence_requests',
      'family_links',
      'form_invitations',
      'form_responses',
      'application_notes',
      'consent_records',
      'representative_authorisations',
      'decisions',
      'certificates',
      'associated_statements',
      'rights_requests',
    ]);
  });

  it('accounts for every subject table: included, or excluded with a reason', () => {
    for (const table of SUBJECT_TABLES) {
      const included = BUNDLE_TABLES.includes(table);
      const excluded = table in BUNDLE_EXCLUSIONS;
      expect(included || excluded, table).toBe(true);
      expect(included && excluded, `${table} is both included and excluded`).toBe(false);
    }
    for (const reason of Object.values(BUNDLE_EXCLUSIONS)) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe('redaction', () => {
  it('redacts a single field', () => {
    const { bundle: out, applied } = applyRedactions(bundle(), [
      { table: 'family_links', recordId: 'fl-1', field: 'relativeName' },
    ]);
    expect(applied).toBe(1);
    const record = out.sections[1]!.records[0]!;
    expect(record.fields.relativeName).toBe(REDACTED);
    expect(record.fields.relationship).toBe('grandmother');
  });

  it('redacts a whole record and ignores redactions that match nothing', () => {
    const { bundle: out, applied } = applyRedactions(bundle(), [
      { table: 'applications', recordId: 'app-0' },
      { table: 'applications', recordId: 'missing' },
      { table: 'family_links', recordId: 'fl-1', field: 'notARealField' },
    ]);
    expect(applied).toBe(1);
    expect(Object.values(out.sections[0]!.records[0]!.fields)).toEqual([
      REDACTED,
      REDACTED,
      REDACTED,
    ]);
  });

  it('does not change the original bundle', () => {
    const original = bundle();
    applyRedactions(original, [{ table: 'applications', recordId: 'app-0' }]);
    expect(original.sections[0]!.records[0]!.fields.reference).toBe('APP-2026-0');
  });
});

describe('bundle PDF', () => {
  it('renders characters the standard font cannot encode without failing', async () => {
    const bytes = await renderBundlePdf(bundle());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe(
      'Personal information held by Example Aboriginal Corporation',
    );
  });

  it('paginates long bundles', async () => {
    const doc = await PDFDocument.load(await renderBundlePdf(bundle(120)));
    expect(doc.getPageCount()).toBeGreaterThan(3);
  });

  it('labels and wraps text', () => {
    expect(labelFor('relativeName')).toBe('Relative name');
    const lines = wrapText('one two three four five', 9, (s) => s.length);
    expect(lines).toEqual(['one two', 'three', 'four five']);
    expect(wrapText('abcdefghij', 4, (s) => s.length)).toEqual(['abcd', 'efgh', 'ij']);
  });
});
