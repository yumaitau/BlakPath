'use client';

import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';

/**
 * Per-member switch for the email copy of in-app notices. The inbox itself
 * always stays on. The control talks only to the tenant-scoped preference API.
 */
export function EmailCopyToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/notifications/email', { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error('unavailable');
          const body = (await response.json()) as { emailNotifications: boolean };
          setEnabled(body.emailNotifications);
          setError(null);
        })
        .catch(() => {
          setError('Email preference is unavailable right now.');
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function onChange(next: boolean) {
    const previous = enabled;
    setPending(true);
    setError(null);
    setEnabled(next);
    try {
      const response = await fetch('/api/notifications/email', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailNotifications: next }),
      });
      if (!response.ok) throw new Error('save failed');
      const body = (await response.json()) as { emailNotifications: boolean };
      setEnabled(body.emailNotifications);
    } catch {
      setEnabled(previous);
      setError('We could not save that preference. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border-border bg-surface mt-6 rounded-lg border p-4 sm:p-5">
      {enabled === null && !error ? (
        <p className="text-muted-foreground text-sm">Loading email preference…</p>
      ) : (
        <div className="flex items-start gap-3">
          <input
            id="email-notifications"
            type="checkbox"
            className="border-border mt-1 size-4 rounded"
            checked={enabled === true}
            disabled={pending || enabled === null}
            onChange={(event) => void onChange(event.target.checked)}
          />
          <div>
            <Label htmlFor="email-notifications">Email me a copy</Label>
            <p className="text-muted-foreground mt-1 text-sm">
              When this is on, BlakPath also emails you that something needs attention.
              The email only asks you to sign in. It never includes names, evidence, or
              case notes.
            </p>
          </div>
        </div>
      )}
      {error ? (
        <p role="status" className="text-status-destructive mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
