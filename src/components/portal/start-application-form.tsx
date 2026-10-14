'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * Start an application with an organisation that has opened public applications.
 * The server checks the flag again. This form does not ask for identity evidence
 * and does not suggest an outcome.
 */
export function StartApplicationForm({
  slug,
  organisationName,
}: {
  slug: string;
  organisationName: string;
}) {
  const [name, setName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!acknowledged) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/organisations/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, applicantName: name }),
      });
      if (!response.ok) {
        setError(
          'The application could not be started. You may need an invitation from this organisation, or they may have closed applications.',
        );
        setPending(false);
        return;
      }
      const payload = (await response.json()) as {
        application: { id: string; organisationId: string };
      };
      const activated = await fetch('/api/organisations/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organisationId: payload.application.organisationId }),
      });
      if (!activated.ok) {
        setError(
          'The application was started, but this account could not open it. Sign in as a member of that organisation and try again.',
        );
        setPending(false);
        return;
      }
      window.location.assign(`/portal/${payload.application.id}`);
    } catch {
      setError(
        'The application could not be started. Check your connection and try again.',
      );
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 flex max-w-lg flex-col gap-4" noValidate>
      {error ? (
        <Alert tone="destructive" role="alert" title="Application not started">
          {error}
        </Alert>
      ) : null}
      <Field id="applicant-name" label="Your name" required>
        {(props) => (
          <Input
            {...props}
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            required
          />
        )}
      </Field>
      <label className="flex items-start gap-2 text-sm" htmlFor="start-acknowledge">
        <input
          id="start-acknowledge"
          type="checkbox"
          className="border-input mt-1 size-4 rounded"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          disabled={pending}
        />
        <span>
          I understand {organisationName} considers this application. BlakPath does not
          determine Aboriginality.
        </span>
      </label>
      <Button type="submit" disabled={pending || !acknowledged}>
        {pending ? 'Starting…' : 'Start application'}
      </Button>
    </form>
  );
}
