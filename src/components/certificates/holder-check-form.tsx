'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Ask the verifier for the name printed on the document.
 * The response is match / no-match only — this form never receives the
 * recorded name or date of birth.
 */

const MESSAGES = {
  match: 'The details you entered match the details sealed on this certificate.',
  no_match:
    'The details you entered do not match the details sealed on this certificate.',
  unbound:
    'This certificate was sealed without a holder name, so the printed name cannot be checked here.',
  not_found: 'We couldn’t find a certificate for this code.',
  rate_limited: 'Too many checks from this network. Wait a few minutes and try again.',
  invalid: 'Enter the name printed on the certificate.',
  error: 'We could not complete this check. Try again shortly.',
} as const;

type HolderResult = keyof typeof MESSAGES;

function isHolderResult(value: string | undefined): value is HolderResult {
  return value !== undefined && value in MESSAGES;
}

export function HolderCheckForm({ code }: { code: string }) {
  const [name, setName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<HolderResult | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setResult(null);
    try {
      const response = await fetch(`/api/public/verify/${encodeURIComponent(code)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          ...(dateOfBirth ? { dateOfBirth } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        result?: string;
      } | null;
      const next = body?.result;
      setResult(isHolderResult(next) ? next : 'error');
    } catch {
      setResult('error');
    } finally {
      setPending(false);
    }
  }

  const tone =
    result === 'match' ? 'success' : result === 'no_match' ? 'warning' : 'info';

  return (
    <form onSubmit={submit} className="mt-6 grid gap-4 border-t pt-6">
      <p className="text-sm">
        Enter the name printed on the document to check it against the seal. This page
        does not show that name.
      </p>
      <div className="grid gap-2">
        <Label htmlFor="holder-name" required>
          Name printed on the certificate
        </Label>
        <Input
          id="holder-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          maxLength={200}
          required
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="holder-dob">Date of birth (optional)</Label>
        <Input
          id="holder-dob"
          name="dateOfBirth"
          type="date"
          value={dateOfBirth}
          onChange={(event) => setDateOfBirth(event.target.value)}
          autoComplete="bday"
        />
        <p className="text-muted-foreground text-sm">
          Only if a date of birth is printed on the certificate. Leave blank to check the
          name only.
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Check details'}
      </Button>
      {result ? (
        <Alert tone={tone} role="status">
          {MESSAGES[result]}
        </Alert>
      ) : null}
    </form>
  );
}
