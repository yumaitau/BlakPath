'use client';

import { useId, useRef, useState } from 'react';

import type { PublicForm } from '@/domains/forms';
import type { FormField } from '@/lib/forms/fields';
import { CollectionNotice } from '@/components/privacy/collection-notice';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * Public form renderer.
 *
 * Renders one control per field and posts the collected answers back to the
 * public submit route. The token is passed straight through to the request — it
 * is the recipient's only capability, and no session is involved. Server-side
 * validation (against the form's own field defs) is the source of truth; the
 * light client coercion here just shapes the answer object.
 *
 * The organisation's collection notice is shown before the questions and must
 * be acknowledged before the form can be submitted; the acknowledgement (notice
 * version + hash) is posted with the answers and re-checked by the server.
 *
 * PRODUCT INVARIANT: a form collects information a human provides. It never
 * scores, ranks or determines a person's Aboriginality.
 */

/** The value we track per field key while the recipient types. */
type AnswerValue = string | boolean | string[];

/** A field always carries a value in state; strings start empty, etc. */
function initialValue(field: FormField): AnswerValue {
  switch (field.type) {
    case 'boolean':
      return false;
    case 'multiselect':
      return [];
    default:
      return '';
  }
}

function buildInitialState(fields: FormField[]): Record<string, AnswerValue> {
  const state: Record<string, AnswerValue> = {};
  for (const field of fields) {
    state[field.key] = initialValue(field);
  }
  return state;
}

function missingRequiredAnswer(field: FormField, value: AnswerValue): boolean {
  if (!field.required || field.type === 'boolean') return false;
  if (field.type === 'multiselect') {
    return !Array.isArray(value) || value.length === 0;
  }
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * Shape the tracked values into the answer object we submit. Empty optional
 * fields are omitted; numbers are coerced; multiselect stays an array. The
 * server re-validates everything, so this only needs to be a faithful mapping.
 */
function buildAnswers(
  fields: FormField[],
  values: Record<string, AnswerValue>,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};

  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined) continue;

    switch (field.type) {
      case 'boolean': {
        // Always send a concrete boolean.
        answers[field.key] = value === true;
        break;
      }
      case 'multiselect': {
        const list = Array.isArray(value) ? value : [];
        // Omit an empty optional multiselect; a required one is sent so the
        // server can flag the omission.
        if (list.length > 0 || field.required) answers[field.key] = list;
        break;
      }
      case 'number':
      case 'integer': {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text === '') {
          if (field.required) answers[field.key] = text;
          break;
        }
        const parsed = Number(text);
        // Leave an unparseable value as the raw string so the server rejects it
        // with a clear validation error rather than silently dropping it.
        answers[field.key] = Number.isNaN(parsed) ? text : parsed;
        break;
      }
      default: {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text !== '' || field.required) answers[field.key] = text;
        break;
      }
    }
  }

  return answers;
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }
  | { status: 'done' };

export function PublicFormRenderer({ token, form }: { token: string; form: PublicForm }) {
  const baseId = useId();
  const [values, setValues] = useState<Record<string, AnswerValue>>(() =>
    buildInitialState(form.fields),
  );
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });
  const [invalidKeys, setInvalidKeys] = useState<ReadonlySet<string>>(new Set());
  const [noticeAcknowledged, setNoticeAcknowledged] = useState(false);
  const [noticeInvalid, setNoticeInvalid] = useState(false);
  const noticeId = `${baseId}-collection-notice`;
  const successRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  function setValue(key: string, value: AnswerValue) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setInvalidKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function toggleMultiselect(key: string, option: string, checked: boolean) {
    setValues((prev) => {
      const current = prev[key];
      const list = Array.isArray(current) ? current : [];
      const next = checked
        ? [...list.filter((o) => o !== option), option]
        : list.filter((o) => o !== option);
      return { ...prev, [key]: next };
    });
    setInvalidKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submit.status === 'submitting') return;

    const missing = form.fields.filter((field) =>
      missingRequiredAnswer(field, values[field.key] ?? initialValue(field)),
    );
    setNoticeInvalid(!noticeAcknowledged);
    if (!noticeAcknowledged || missing.length > 0) {
      const keys = new Set(missing.map(({ key }) => key));
      setInvalidKeys(keys);
      setSubmit({
        status: 'error',
        message: noticeAcknowledged
          ? 'Some answers need another look. Please check the form and try again.'
          : 'Please read and confirm the collection notice before submitting.',
      });
      const first = missing[0];
      requestAnimationFrame(() => {
        if (!noticeAcknowledged) {
          document.getElementById(noticeId)?.focus();
          return;
        }
        if (!first) return;
        const id = `${baseId}-${first.key}`;
        const focusId = first.type === 'multiselect' ? `${id}-opt-0` : id;
        document.getElementById(focusId)?.focus();
      });
      return;
    }

    setInvalidKeys(new Set());
    setSubmit({ status: 'submitting' });
    const answers = buildAnswers(form.fields, values);

    try {
      const res = await fetch(`/api/public/forms/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers,
          acknowledgement: { version: form.notice.version, hash: form.notice.hash },
        }),
      });

      if (res.ok) {
        setSubmit({ status: 'done' });
        // Move focus to the confirmation so screen readers announce it.
        requestAnimationFrame(() => successRef.current?.focus());
        return;
      }

      if (res.status === 404) {
        setSubmit({
          status: 'error',
          message: 'This link is no longer valid.',
        });
        requestAnimationFrame(() => errorRef.current?.focus());
        return;
      }

      if (res.status === 409) {
        setSubmit({
          status: 'error',
          message:
            'The collection notice has changed since this page opened. Please reload the page and review it before submitting.',
        });
        requestAnimationFrame(() => errorRef.current?.focus());
        return;
      }

      // 400 (invalid answers) and anything else: keep the entered values so the
      // recipient can correct and retry.
      setSubmit({
        status: 'error',
        message: 'Some answers need another look. Please check the form and try again.',
      });
      requestAnimationFrame(() => errorRef.current?.focus());
    } catch {
      setSubmit({
        status: 'error',
        message:
          'We could not reach the server. Please check your connection and try again.',
      });
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }

  if (submit.status === 'done') {
    return (
      <Card>
        <CardContent
          ref={successRef}
          tabIndex={-1}
          className="pt-6 focus-visible:outline-none"
        >
          <h1 className="text-foreground text-xl font-semibold">
            Thank you — your response has been recorded.
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            You can close this page now. There is nothing more to do.
          </p>
        </CardContent>
      </Card>
    );
  }

  const isSubmitting = submit.status === 'submitting';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{form.title}</CardTitle>
        {form.description ? (
          <p className="text-muted-foreground text-sm">{form.description}</p>
        ) : null}
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
          <CollectionNotice
            notice={form.notice}
            id={noticeId}
            headingLevel={4}
            acknowledged={noticeAcknowledged}
            invalid={noticeInvalid}
            onAcknowledgedChange={(acknowledged) => {
              setNoticeAcknowledged(acknowledged);
              if (acknowledged) setNoticeInvalid(false);
            }}
          />
          {form.fields.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              baseId={baseId}
              value={values[field.key] ?? initialValue(field)}
              invalid={invalidKeys.has(field.key)}
              onValueChange={(value) => setValue(field.key, value)}
              onToggleOption={(option, checked) =>
                toggleMultiselect(field.key, option, checked)
              }
            />
          ))}

          {submit.status === 'error' ? (
            <p
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className="text-destructive text-sm font-medium focus:outline-none"
            >
              {submit.message}
            </p>
          ) : null}

          <div>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Submitting…' : 'Submit'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Render a single field's control, wired for accessibility. */
function FieldControl({
  field,
  baseId,
  value,
  invalid,
  onValueChange,
  onToggleOption,
}: {
  field: FormField;
  baseId: string;
  value: AnswerValue;
  invalid: boolean;
  onValueChange: (value: AnswerValue) => void;
  onToggleOption: (option: string, checked: boolean) => void;
}) {
  const id = `${baseId}-${field.key}`;
  const helpText = field.helpText ?? undefined;

  // Boolean and multiselect are group-shaped, so they manage their own labelling
  // rather than going through the single-control Field wrapper.
  if (field.type === 'boolean') {
    const checked = value === true;
    const descriptionId = helpText ? `${id}-description` : undefined;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            aria-required={field.required}
            aria-invalid={invalid || undefined}
            {...(descriptionId ? { 'aria-describedby': descriptionId } : {})}
            onChange={(e) => onValueChange(e.target.checked)}
            className="border-input text-primary focus-visible:ring-ring mt-0.5 size-5 rounded"
          />
          <Label htmlFor={id} required={field.required} className="font-medium">
            {field.label}
          </Label>
        </div>
        {helpText ? (
          <p id={descriptionId} className="text-muted-foreground text-sm">
            {helpText}
          </p>
        ) : null}
      </div>
    );
  }

  if (field.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    const descriptionId = helpText ? `${id}-description` : undefined;
    const errorId = invalid ? `${id}-error` : undefined;
    const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
    return (
      <fieldset
        className="flex flex-col gap-2"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      >
        <legend className="text-foreground inline-flex items-center gap-1 text-sm font-medium">
          {field.label}
          {field.required ? (
            <span className="text-destructive">
              <span aria-hidden="true">*</span>
              <span className="sr-only"> (required)</span>
            </span>
          ) : null}
        </legend>
        {helpText ? (
          <p id={descriptionId} className="text-muted-foreground text-sm">
            {helpText}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          {field.options.map((option, index) => {
            const optionId = `${id}-opt-${index}`;
            return (
              <div key={option} className="flex items-center gap-2">
                <input
                  id={optionId}
                  type="checkbox"
                  checked={selected.includes(option)}
                  onChange={(e) => onToggleOption(option, e.target.checked)}
                  className="border-input text-primary focus-visible:ring-ring size-5 rounded"
                />
                <Label htmlFor={optionId} className="font-normal">
                  {option}
                </Label>
              </div>
            );
          })}
        </div>
        {invalid ? (
          <p id={errorId} role="alert" className="text-destructive text-sm font-medium">
            This answer is required.
          </p>
        ) : null}
      </fieldset>
    );
  }

  const stringValue = typeof value === 'string' ? value : '';

  return (
    <Field
      id={id}
      label={field.label}
      required={field.required}
      error={invalid ? 'This answer is required.' : undefined}
      {...(helpText ? { description: helpText } : {})}
    >
      {(props) => {
        switch (field.type) {
          case 'longText':
            return (
              <Textarea
                {...props}
                aria-required={field.required}
                value={stringValue}
                {...(field.maxLength ? { maxLength: field.maxLength } : {})}
                onChange={(e) => onValueChange(e.target.value)}
              />
            );
          case 'number':
          case 'integer':
            return (
              <Input
                {...props}
                type="number"
                inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
                {...(field.type === 'integer' ? { step: 1 } : {})}
                {...(field.min != null ? { min: field.min } : {})}
                {...(field.max != null ? { max: field.max } : {})}
                aria-required={field.required}
                value={stringValue}
                onChange={(e) => onValueChange(e.target.value)}
              />
            );
          case 'date':
            return (
              <Input
                {...props}
                type="date"
                aria-required={field.required}
                value={stringValue}
                onChange={(e) => onValueChange(e.target.value)}
              />
            );
          case 'email':
            return (
              <Input
                {...props}
                type="email"
                autoComplete="email"
                aria-required={field.required}
                value={stringValue}
                onChange={(e) => onValueChange(e.target.value)}
              />
            );
          case 'phone':
            return (
              <Input
                {...props}
                type="tel"
                autoComplete="tel"
                aria-required={field.required}
                value={stringValue}
                onChange={(e) => onValueChange(e.target.value)}
              />
            );
          case 'select':
            return (
              <select
                {...props}
                aria-required={field.required}
                value={stringValue}
                onChange={(e) => onValueChange(e.target.value)}
                className={cn(
                  'border-input bg-surface text-foreground flex h-11 w-full rounded-md border px-3 py-2 text-base',
                  'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
                  'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/40',
                )}
              >
                <option value="">Please choose…</option>
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            );
          case 'text':
          default:
            return (
              <Input
                {...props}
                type="text"
                aria-required={field.required}
                {...('maxLength' in field && field.maxLength
                  ? { maxLength: field.maxLength }
                  : {})}
                value={stringValue}
                onChange={(e) => onValueChange(e.target.value)}
              />
            );
        }
      }}
    </Field>
  );
}
