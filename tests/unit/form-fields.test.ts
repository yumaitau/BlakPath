import { describe, expect, it } from 'vitest';
import {
  FIELD_TYPE_LABELS,
  FORM_FIELD_TYPES,
  FormFieldsArraySchema,
  buildResponseSchema,
  draftIsCurrent,
  formatAnswerValue,
  isSubmittableFormFileStatus,
  parseFieldsJson,
  validateDraft,
  validateResponse,
  type FormField,
} from '@/lib/forms/fields';

function field(partial: Partial<FormField> & { type: FormField['type'] }): FormField {
  return {
    id: '018f5b3a-0000-7000-8000-000000000001',
    key: 'q1',
    label: 'Question 1',
    required: false,
    ...partial,
  } as FormField;
}

describe('form field model', () => {
  it('labels every field type', () => {
    for (const type of FORM_FIELD_TYPES) {
      expect(FIELD_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it('rejects duplicate keys and bad key formats', () => {
    const dup = [
      field({ type: 'text', id: '018f5b3a-0000-7000-8000-00000000000a', key: 'name' }),
      field({ type: 'text', id: '018f5b3a-0000-7000-8000-00000000000b', key: 'name' }),
    ];
    expect(FormFieldsArraySchema.safeParse(dup).success).toBe(false);

    const badKey = [field({ type: 'text', key: 'Not A Key' })];
    expect(FormFieldsArraySchema.safeParse(badKey).success).toBe(false);
  });
});

describe('buildResponseSchema — required vs optional', () => {
  const fields: FormField[] = [
    field({ type: 'text', key: 'full_name', required: true, label: 'Full name' }),
    field({
      id: '018f5b3a-0000-7000-8000-000000000002',
      type: 'email',
      key: 'email',
      required: false,
      label: 'Email',
    }),
  ];

  it('requires required fields and allows omitting optional ones', () => {
    const schema = buildResponseSchema(fields);
    expect(schema.safeParse({ full_name: 'Jo Blak' }).success).toBe(true);
    expect(schema.safeParse({ email: 'jo@example.org' }).success).toBe(false); // missing required
    expect(schema.safeParse({ full_name: 'Jo', email: 'not-an-email' }).success).toBe(
      false,
    );
  });

  it('strips unknown keys a client tries to smuggle in', () => {
    const parsed = buildResponseSchema(fields).safeParse({
      full_name: 'Jo',
      injected: 'nope',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('injected' in parsed.data).toBe(false);
  });
});

describe('typed field validation', () => {
  it('enforces number bounds', () => {
    const fields = [
      field({ type: 'integer', key: 'age', required: true, min: 0, max: 120 } as never),
    ];
    expect(validateResponse(fields, { age: 30 }).success).toBe(true);
    expect(validateResponse(fields, { age: 200 }).success).toBe(false);
    expect(validateResponse(fields, { age: 3.5 }).success).toBe(false);
  });

  it('enforces select options', () => {
    const fields = [
      field({
        type: 'select',
        key: 'mob',
        required: true,
        options: ['A', 'B'],
      } as never),
    ];
    expect(validateResponse(fields, { mob: 'A' }).success).toBe(true);
    expect(validateResponse(fields, { mob: 'Z' }).success).toBe(false);
  });

  it('requires at least one choice for a required multiselect', () => {
    const fields = [
      field({
        type: 'multiselect',
        key: 'records',
        required: true,
        options: ['Family record', 'Community record'],
      } as never),
    ];
    expect(validateResponse(fields, { records: [] }).success).toBe(false);
    expect(validateResponse(fields, { records: ['Family record'] }).success).toBe(true);
  });
});

describe('file fields', () => {
  const fields = [
    field({
      type: 'file',
      key: 'birth_record',
      required: true,
      label: 'Birth record',
    }),
  ];
  const evidenceId = '018f5b3a-0000-7000-8000-0000000000aa';

  it('allows omitting an optional file', () => {
    expect(
      validateResponse([field({ type: 'file', key: 'scan', required: false })], {})
        .success,
    ).toBe(true);
  });

  it('accepts an evidence id and rejects a filename or path', () => {
    expect(validateResponse(fields, { birth_record: evidenceId }).success).toBe(true);
    expect(validateResponse(fields, { birth_record: 'certificate.pdf' }).success).toBe(
      false,
    );
    expect(validateResponse(fields, { birth_record: '../secrets.pdf' }).success).toBe(
      false,
    );
  });

  it('treats only quarantined and clean uploads as submittable', () => {
    expect(isSubmittableFormFileStatus('quarantined')).toBe(true);
    expect(isSubmittableFormFileStatus('clean')).toBe(true);
    expect(isSubmittableFormFileStatus('pending')).toBe(false);
    expect(isSubmittableFormFileStatus('infected')).toBe(false);
    expect(isSubmittableFormFileStatus('rejected')).toBe(false);
  });

  it('displays a file answer without the storage id', () => {
    expect(formatAnswerValue(evidenceId, 'file')).toBe('File uploaded');
  });
});

describe('draft answers', () => {
  const fields: FormField[] = [
    field({ type: 'text', key: 'full_name', required: true, label: 'Full name' }),
    field({
      id: '018f5b3a-0000-7000-8000-000000000002',
      type: 'email',
      key: 'email',
      required: true,
      label: 'Email',
    }),
  ];

  it('keeps a half-finished answer set and drops unknown keys', () => {
    const parsed = validateDraft(fields, { full_name: 'Jo Blak', injected: 'nope' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ full_name: 'Jo Blak' });
    }
  });

  it('rejects a present value of the wrong type', () => {
    expect(validateDraft(fields, { email: 'not-an-email' }).success).toBe(false);
  });

  it('is current only before its expiry', () => {
    const now = new Date('2026-10-13T00:00:00.000Z');
    expect(draftIsCurrent('2026-10-14T00:00:00.000Z', now)).toBe(true);
    expect(draftIsCurrent('2026-10-13T00:00:00.000Z', now)).toBe(false);
    expect(draftIsCurrent(null, now)).toBe(false);
  });
});

describe('parseFieldsJson', () => {
  it('returns [] for non-array / malformed JSON', () => {
    expect(parseFieldsJson(null)).toEqual([]);
    expect(parseFieldsJson('nope')).toEqual([]);
    expect(parseFieldsJson([{ type: 'unknown' }])).toEqual([]);
  });

  it('round-trips a valid field list', () => {
    const list = [field({ type: 'text', key: 'x', required: true })];
    expect(parseFieldsJson(list)).toHaveLength(1);
  });
});
