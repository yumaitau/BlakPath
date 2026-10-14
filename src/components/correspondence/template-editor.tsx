'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useHydrated } from '@/lib/hooks/use-hydrated';

/**
 * Organisation letter templates. Editing a template does not send anything
 * and does not rewrite letters already stored on a case.
 */

export interface TemplateEditorItem {
  id: string;
  name: string;
  kind: string;
  subjectTemplate: string;
  bodyTemplate: string;
  active: boolean;
}

const KINDS = [
  ['outcome', 'Outcome'],
  ['evidence_request', 'Evidence request'],
  ['revocation', 'Revocation'],
  ['certificate', 'Certificate'],
  ['general', 'General'],
] as const;

const FIELDS = [
  'applicant.name',
  'application.reference',
  'organisation.name',
  'decision.outcome',
  'decision.finalised_on',
  'evidence.due_date',
  'evidence.summary',
  'certificate.reference',
  'portal.url',
];

export function TemplateEditor({ templates }: { templates: TemplateEditorItem[] }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const locked = !hydrated || busy !== null;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('general');
  const [subjectTemplate, setSubjectTemplate] = useState('');
  const [bodyTemplate, setBodyTemplate] = useState('');

  async function submit(key: string, url: string, method: string, body?: unknown) {
    setBusy(key);
    setError(null);
    try {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const response = await fetch(url, init);
      const data: { error?: string } = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? 'That action could not be completed.');
        return;
      }
      if (key === 'create') {
        setName('');
        setSubjectTemplate('');
        setBodyTemplate('');
      }
      router.refresh();
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <Alert tone="destructive" role="alert">
          {error}
        </Alert>
      ) : null}
      <p className="text-muted-foreground text-sm">
        Merge fields: {FIELDS.map((field) => `{{${field}}}`).join(', ')}. Outcome wording
        belongs in the letter. Emails only carry a secure link and, for an evidence
        request, the due date.
      </p>
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => submit('seed', '/api/correspondence/templates/seed', 'POST')}
        >
          {busy === 'seed' ? 'Adding…' : 'Add starter templates'}
        </Button>
      </div>

      <ul className="flex flex-col gap-6">
        {templates.map((template) => (
          <li key={template.id} className="border-border rounded-xl border p-4">
            <TemplateForm
              template={template}
              busy={busy === template.id}
              disabled={locked}
              onSave={(value) =>
                submit(
                  template.id,
                  `/api/correspondence/templates/${template.id}`,
                  'PATCH',
                  value,
                )
              }
            />
          </li>
        ))}
      </ul>

      <form
        className="border-border flex flex-col gap-4 rounded-xl border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit('create', '/api/correspondence/templates', 'POST', {
            name,
            kind,
            subjectTemplate,
            bodyTemplate,
          });
        }}
      >
        <h2 className="font-semibold">New template</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="template-name" required>
            Name
          </Label>
          <Input
            id="template-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="template-kind">Type</Label>
          <select
            id="template-kind"
            className="border-input bg-surface h-11 rounded-md border px-3 text-base"
            disabled={!hydrated}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            {KINDS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="template-subject" required>
            Subject
          </Label>
          <Input
            id="template-subject"
            value={subjectTemplate}
            onChange={(event) => setSubjectTemplate(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="template-body" required>
            Letter
          </Label>
          <Textarea
            id="template-body"
            rows={8}
            value={bodyTemplate}
            onChange={(event) => setBodyTemplate(event.target.value)}
            required
          />
        </div>
        <div>
          <Button type="submit" disabled={locked}>
            {busy === 'create' ? 'Saving…' : 'Save template'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function TemplateForm({
  template,
  busy,
  disabled,
  onSave,
}: {
  template: TemplateEditorItem;
  busy: boolean;
  disabled: boolean;
  onSave: (value: {
    name: string;
    subjectTemplate: string;
    bodyTemplate: string;
    active: boolean;
  }) => void;
}) {
  const [name, setName] = useState(template.name);
  const [subjectTemplate, setSubjectTemplate] = useState(template.subjectTemplate);
  const [bodyTemplate, setBodyTemplate] = useState(template.bodyTemplate);
  const [active, setActive] = useState(template.active);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ name, subjectTemplate, bodyTemplate, active });
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">{template.kind}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          Active
        </label>
      </div>
      <Input
        aria-label="Template name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />
      <Input
        aria-label="Subject template"
        value={subjectTemplate}
        onChange={(event) => setSubjectTemplate(event.target.value)}
        required
      />
      <Textarea
        aria-label="Letter template"
        rows={6}
        value={bodyTemplate}
        onChange={(event) => setBodyTemplate(event.target.value)}
        required
      />
      <div>
        <Button type="submit" size="sm" variant="outline" disabled={disabled}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
