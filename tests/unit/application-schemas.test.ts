import { describe, expect, it } from 'vitest';
import { encodeApplicationCursor } from '@/domains/applications/cursor';
import {
  addNoteSchema,
  assignApplicationSchema,
  createApplicationSchema,
  listApplicationsSchema,
  transitionApplicationSchema,
  updateIntakeSchema,
} from '@/domains/applications/schemas';

describe('createApplicationSchema', () => {
  it('requires a non-empty applicant name and defaults priority', () => {
    const parsed = createApplicationSchema.parse({ applicantName: '  Jo Blak  ' });
    expect(parsed.applicantName).toBe('Jo Blak');
    expect(parsed.priority).toBe('normal');
  });

  it('rejects an empty name and a non-uuid applicant id', () => {
    expect(createApplicationSchema.safeParse({ applicantName: '' }).success).toBe(false);
    expect(
      createApplicationSchema.safeParse({
        applicantName: 'Jo',
        applicantUserId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown priority', () => {
    expect(
      createApplicationSchema.safeParse({ applicantName: 'Jo', priority: 'urgent' })
        .success,
    ).toBe(false);
  });
});

describe('updateIntakeSchema', () => {
  it('requires at least one field', () => {
    expect(updateIntakeSchema.safeParse({}).success).toBe(false);
    expect(updateIntakeSchema.safeParse({ priority: 'high' }).success).toBe(true);
  });

  it('accepts a client link on its own', () => {
    expect(
      updateIntakeSchema.safeParse({
        clientId: '018f5b3a-0000-7000-8000-000000000000',
      }).success,
    ).toBe(true);
    expect(updateIntakeSchema.safeParse({ clientId: 'nope' }).success).toBe(false);
  });
});

describe('assignApplicationSchema', () => {
  it('requires a uuid assignee', () => {
    expect(assignApplicationSchema.safeParse({ assigneeUserId: 'nope' }).success).toBe(
      false,
    );
    expect(
      assignApplicationSchema.safeParse({
        assigneeUserId: '018f5b3a-0000-7000-8000-000000000000',
      }).success,
    ).toBe(true);
  });
});

describe('transitionApplicationSchema', () => {
  it('accepts an empty payload and bounds the note', () => {
    expect(transitionApplicationSchema.safeParse({}).success).toBe(true);
    expect(
      transitionApplicationSchema.safeParse({ note: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });
});

describe('listApplicationsSchema', () => {
  it('applies limit/offset defaults and coerces strings', () => {
    const parsed = listApplicationsSchema.parse({});
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(0);
    expect(listApplicationsSchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('rejects an out-of-range limit and unknown status', () => {
    expect(listApplicationsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listApplicationsSchema.safeParse({ limit: 1000 }).success).toBe(false);
    expect(listApplicationsSchema.safeParse({ status: 'approved' }).success).toBe(false);
  });

  it('accepts search, assignee, and a cursor, and treats blanks as unset', () => {
    const cursor = encodeApplicationCursor({
      createdAt: '2026-04-01T00:00:00.000000Z',
      id: '018f5b3a-0000-7000-8000-0000000000ab',
    });
    const parsed = listApplicationsSchema.parse({
      q: '  smith ',
      status: 'draft',
      assigneeUserId: '018f5b3a-0000-7000-8000-000000000000',
      cursor,
    });
    expect(parsed.q).toBe('smith');
    expect(parsed.cursor).toBe(cursor);
    expect(listApplicationsSchema.parse({ q: '', cursor: '' }).q).toBeUndefined();
    expect(listApplicationsSchema.safeParse({ cursor: 'nope' }).success).toBe(false);
    expect(listApplicationsSchema.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('addNoteSchema', () => {
  it('defaults visibility to staff and requires a body', () => {
    expect(addNoteSchema.parse({ body: 'note' }).visibility).toBe('staff');
    expect(addNoteSchema.safeParse({ body: '' }).success).toBe(false);
    expect(addNoteSchema.safeParse({ body: 'n', visibility: 'world' }).success).toBe(
      false,
    );
  });
});
