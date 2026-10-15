import { FORM_FIELD_TYPES, type FormField, type FormFieldType } from '@/lib/forms/fields';

/**
 * Pure helpers for the staff form builder.
 *
 * These turn a human's label into a stable answer `key`, keep keys unique across
 * a form, and mint a fresh empty field of a chosen type with sensible defaults.
 * Everything here is pure (no IO beyond `crypto.randomUUID`) so it unit-tests
 * without a harness and can run on either the client or the server.
 *
 * PRODUCT INVARIANT: a form collects information a human provides. It never
 * scores, ranks or determines a person's Aboriginality — these helpers only
 * shape the field definitions an author is editing.
 */

/**
 * Derive a valid field `key` from a human label.
 *
 * The key must match `/^[a-z][a-z0-9_]{0,40}$/`: lowercase, starting with a
 * letter. We lowercase, turn any run of non-alphanumeric characters into a
 * single underscore, trim leading digits/underscores (so the first character is
 * a letter), trim trailing underscores, and cap the length. An empty result
 * falls back to `field`.
 */
export function slugifyKey(label: string): string {
  const collapsed = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // non-alphanumeric runs → single underscore
    .replace(/_+/g, '_') // collapse any repeats
    .replace(/^[0-9_]+/, '') // drop leading digits/underscores (key must start with a letter)
    .replace(/_+$/, ''); // drop trailing underscores

  const capped = collapsed.slice(0, 41);
  return capped.length > 0 ? capped : 'field';
}

/**
 * Return `base` if it is not already taken, otherwise append `_2`, `_3`, … until
 * the key is unique. The suffixed key is re-capped to stay within 41 characters.
 */
export function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const trimmed = base.slice(0, 41 - suffix.length);
    const candidate = `${trimmed}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Human-facing default label for a fresh field of each type. */
const DEFAULT_LABELS: Record<FormFieldType, string> = {
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

/**
 * Build a fresh, valid empty field of `type` with sensible defaults and a key
 * that is unique against `taken`. Select/multiselect start with a single option
 * so they satisfy the field schema's `.min(1)` on options.
 */
export function makeEmptyField(type: FormFieldType, taken: Set<string>): FormField {
  const label = DEFAULT_LABELS[type];
  const key = uniqueKey(slugifyKey(label), taken);
  const base = {
    id: crypto.randomUUID(),
    key,
    label,
    required: false,
  };

  switch (type) {
    case 'select':
    case 'multiselect':
      return { ...base, type, options: ['Option 1'] };
    default:
      return { ...base, type };
  }
}

/** Re-export so callers can iterate the known types without a second import. */
export { FORM_FIELD_TYPES };
