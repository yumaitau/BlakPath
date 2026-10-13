'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Staff actions that connect one submitted response to a case.
 *
 * Creating a case records a draft application and links this response back to
 * it. Attaching uses a case that already exists. Neither action scores or
 * decides a person's Aboriginality.
 */

export function FormResponseActions({
  formId,
  responseId,
  applicationId,
}: {
  formId: string;
  responseId: string;
  applicationId: string | null;
}) {
  const router = useRouter();
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (applicationId) {
    return (
      <Link
        href={`/applications/${applicationId}`}
        className="text-primary text-sm font-medium underline"
      >
        View linked case
      </Link>
    );
  }

  async function post(body: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/forms/${formId}/responses/${responseId}/case`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        setError('This response is already linked to a case.');
        return;
      }
      if (!res.ok) {
        setError('That case could not be linked. Check the reference and try again.');
        return;
      }
      router.refresh();
    } catch {
      setError('That case could not be linked. Check the reference and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => {
            void post({});
          }}
        >
          {busy ? 'Working…' : 'Create case from response'}
        </Button>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = reference.trim();
          if (!trimmed) return;
          const upper = trimmed.toUpperCase();
          const body = upper.startsWith('APP-')
            ? { reference: upper }
            : { applicationId: trimmed };
          void post(body);
        }}
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`attach-${responseId}`}
            className="text-muted-foreground text-xs"
          >
            Existing case reference or id
          </label>
          <Input
            id={`attach-${responseId}`}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="APP-2026-ABC123"
            className="h-9 w-56"
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={busy || reference.trim() === ''}
        >
          Attach to case
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
