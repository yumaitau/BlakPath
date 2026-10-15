'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

/**
 * Withdraw is a human choice by the applicant. The record stays. Nothing here
 * scores the decision to withdraw or predicts what the organisation will do next.
 */
export function WithdrawApplication({ applicationId }: { applicationId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'transition',
          action: 'withdraw',
          ...(reason.trim() ? { note: reason.trim() } : {}),
        }),
      });
      if (!response.ok) {
        setError('The application could not be withdrawn. You can try again.');
        return;
      }
      setReason('');
      setConfirmed(false);
      router.refresh();
    } catch {
      setError(
        'The application could not be withdrawn. Check your connection and try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
      {error ? (
        <Alert tone="destructive" role="alert" title="Not withdrawn">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-1">
        <Label htmlFor="withdraw-reason">Reason, if you want to leave one</Label>
        <textarea
          id="withdraw-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={2000}
          rows={3}
          className="border-input bg-surface rounded-md border px-3 py-2 text-sm"
        />
      </div>
      <label className="flex items-start gap-2 text-sm" htmlFor="withdraw-confirm">
        <input
          id="withdraw-confirm"
          type="checkbox"
          className="border-input mt-1 size-4 rounded"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>I want to withdraw this application</span>
      </label>
      <Button type="submit" variant="outline" disabled={pending || !confirmed}>
        {pending ? 'Withdrawing…' : 'Withdraw this application'}
      </Button>
    </form>
  );
}
