import { z } from 'zod';

/**
 * Custom form field engine.
 *
 * Adapted from RangerOS's `activity-templates` field model: a form is a list of
 * typed field definitions, and those definitions COMPILE at runtime into a zod
 * schema that validates a submitted response. This keeps one source of truth —
 * the field list — for both the builder UI and server-side validation, so a
 * recipient can never submit a value the form did not ask for.
 *
 * Everything here is pure (no IO), so it unit-tests without a harness.
 *
 * PRODUCT INVARIANT: a form collects information a human provides. It never
 * scores, ranks or determines a person's Aboriginality.
 */

/** The field types a form author can choose from. */
export const FORM_FIELD_TYPES = [
  'text',
  'longText',
  'number',
  'integer',
  'date',
  'boolean',
  'email',
  'phone',
  'select',
  'multiselect',
  'file',
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Human labels for each field type (for the builder UI). */
export const FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
  text: 'Short text',
  longText: 'Paragraph',
  number: 'Number',
  integer: 'Whole number',
  date: 'Date',
  boolean: 'Yes / No',
  email: 'Email address',
  phone: 'Phone number',
  select: 'Choose one',
  multiselect: 'Choose many',
  file: 'File',
};

/** Shared properties every field carries. `key` is the stable answer key. */
const FieldBase = z.object({
  id: z.uuid(),
  key: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]{0,40}$/,
      'Key must start with a lowercase letter, then lowercase letters, digits or underscores (max 41 chars).',
    ),
  label: z.string().trim().min(1).max(200),
  required: z.boolean().default(false),
  helpText: z.string().max(500).nullish(),
});

/** A single form field definition (discriminated on `type`). */
export const FormFieldSchema = z.discriminatedUnion('type', [
  FieldBase.extend({
    type: z.literal('text'),
    maxLength: z.number().int().positive().max(1000).optional(),
  }),
  FieldBase.extend({
    type: z.literal('longText'),
    maxLength: z.number().int().positive().max(10000).optional(),
  }),
  FieldBase.extend({
    type: z.literal('number'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  FieldBase.extend({
    type: z.literal('integer'),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  }),
  FieldBase.extend({ type: z.literal('date') }),
  FieldBase.extend({ type: z.literal('boolean') }),
  FieldBase.extend({ type: z.literal('email') }),
  FieldBase.extend({ type: z.literal('phone') }),
  FieldBase.extend({
    type: z.literal('select'),
    options: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
  }),
  FieldBase.extend({
    type: z.literal('multiselect'),
    options: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
  }),
  FieldBase.extend({ type: z.literal('file') }),
]);

export type FormField = z.infer<typeof FormFieldSchema>;

/** The full field list: ids and keys must each be unique. */
export const FormFieldsArraySchema = z
  .array(FormFieldSchema)
  .max(100)
  .refine((arr) => new Set(arr.map((f) => f.id)).size === arr.length, {
    message: 'Field ids must be unique.',
  })
  .refine((arr) => new Set(arr.map((f) => f.key)).size === arr.length, {
    message: 'Field keys must be unique.',
  });

/** Build the zod schema for ONE field's value (before required/optional). */
function valueSchemaForField(field: FormField): z.ZodTypeAny {
  switch (field.type) {
    case 'text': {
      let s = z.string().trim().min(1);
      if (field.maxLength) s = s.max(field.maxLength);
      return s;
    }
    case 'longText': {
      let s = z.string().trim().min(1);
      if (field.maxLength) s = s.max(field.maxLength);
      return s;
    }
    case 'number': {
      let s = z.number();
      if (field.min != null) s = s.min(field.min);
      if (field.max != null) s = s.max(field.max);
      return s;
    }
    case 'integer': {
      let s = z.number().int();
      if (field.min != null) s = s.min(field.min);
      if (field.max != null) s = s.max(field.max);
      return s;
    }
    case 'date':
      return z.coerce.date();
    case 'boolean':
      return z.boolean();
    case 'email':
      return z.email();
    case 'phone':
      return z.string().trim().min(3).max(40);
    case 'select':
      return z.enum(field.options as [string, ...string[]]);
    case 'multiselect':
      return z.array(z.enum(field.options as [string, ...string[]])).min(1);
    case 'file':
      // The answer is the evidence id. Bytes never travel in the JSON body;
      // they go through the quarantine upload and are scanned like other evidence.
      return z.uuid();
  }
}

/**
 * Compile a field list into the zod schema for a submitted answer set. Answers
 * are keyed by each field's `key`. Optional fields accept null/undefined.
 * Unknown keys are stripped (zod object default), so a client cannot smuggle in
 * data the form did not define.
 */
export function buildResponseSchema(
  fields: readonly FormField[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const base = valueSchemaForField(field);
    shape[field.key] = field.required ? base : base.nullish();
  }
  return z.object(shape);
}

/** Validate a raw answer object against a field list. */
export function validateResponse(
  fields: readonly FormField[],
  answers: unknown,
): z.ZodSafeParseResult<Record<string, unknown>> {
  return buildResponseSchema(fields).safeParse(answers) as z.ZodSafeParseResult<
    Record<string, unknown>
  >;
}

/**
 * A form file may be submitted once the upload has entered the scan pipeline
 * (`quarantined`) or finished clean. `pending` means the bytes were never
 * confirmed. Infected and rejected files are not answers.
 */
export function isSubmittableFormFileStatus(status: string): boolean {
  return status === 'quarantined' || status === 'clean';
}

/** True when a saved draft is still inside its expiry. A missing expiry is dead. */
export function draftIsCurrent(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (expiresAt == null) return false;
  const time = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  return Number.isFinite(time) && time > now.getTime();
}

export type DraftParseResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false };

function isBlankDraftValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}

/**
 * Validate a partial answer set for a draft. Required fields may be omitted.
 * Present values must still match the field type. Unknown keys are dropped.
 */
export function validateDraft(
  fields: readonly FormField[],
  answers: unknown,
): DraftParseResult {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    return { success: false };
  }

  const byKey = new Map(fields.map((field) => [field.key, field]));
  const data: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    const field = byKey.get(key);
    if (!field) continue;
    if (field.type !== 'boolean' && isBlankDraftValue(value)) continue;
    const parsed = valueSchemaForField(field).safeParse(value);
    if (!parsed.success) return { success: false };
    data[key] = parsed.data;
  }

  return { success: true, data };
}

/** Staff-facing display for one answer. File bytes are never inlined. */
export function formatAnswerValue(value: unknown, type?: FormFieldType): string {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'file') return 'File uploaded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((item) => String(item)).join(', ') : '—';
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Loose-but-safe guard for a `fields` value coming out of a JSONB column. */
export function parseFieldsJson(value: unknown): FormField[] {
  const result = FormFieldsArraySchema.safeParse(value);
  return result.success ? result.data : [];
}
