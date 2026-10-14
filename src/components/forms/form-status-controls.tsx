'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readConflictMessage } from '@/lib/http/conflict-message';

/**
 * Publish / close controls for a form.
 *
 * A draft or closed form can be published (making its link completable); a
 * published form can be closed (stopping new completions). The change POSTs to
 * `/api/forms/{formId}/status` and refreshes the page on success.
 */
export function FormStatusControls({
  formId,
  status,
}: {
  formId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(next: 'published' | 'closed') {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/forms/${formId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        setError(
          (await readConflictMessage(res)) ??
            'Could not update the form status. Please try again.',
        );
        return;
      }
      router.refresh();
    } catch {
      setError('Could not update the form status. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status !== 'published' ? (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => setStatus('published')}
        >
          Publish
        </Button>
      ) : null}
      {status === 'published' ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => setStatus('closed')}
        >
          Close form
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}
