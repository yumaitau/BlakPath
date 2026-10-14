'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { twoFactor } from '@/lib/auth/client';
import { safeReturnTo } from '@/lib/auth/return-to';

/**
 * Second-factor verification.
 *
 * A user reaches this page after supplying a correct password on an account
 * with two-factor enabled (the client's `onTwoFactorRedirect` hook brings them
 * here). They confirm a 6-digit TOTP code, or switch to a one-time backup code
 * if they can't reach their authenticator.
 *
 * Copy stays generic on failure — we only say the code didn't match.
 */

type Mode = 'totp' | 'backup';

export default function TwoFactorPage() {
  const [mode, setMode] = useState<Mode>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const codeRef = useRef<HTMLInputElement>(null);

  const isTotp = mode === 'totp';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const trimmed = code.trim();
    const { error: verifyError } = isTotp
      ? await twoFactor.verifyTotp({ code: trimmed })
      : await twoFactor.verifyBackupCode({ code: trimmed });

    if (verifyError) {
      setError(
        isTotp
          ? 'That code didn’t match. Check your authenticator app and try again.'
          : 'That backup code didn’t match. Check the code and try again.',
      );
      setPending(false);
      codeRef.current?.focus();
      return;
    }

    window.location.href = safeReturnTo(
      new URLSearchParams(window.location.search).get('returnTo'),
    );
  }

  function switchMode(next: Mode) {
    setMode(next);
    setCode('');
    setError(null);
  }

  return (
    <AuthCard
      title="Two-step verification"
      subtitle={
        isTotp
          ? 'Enter the 6-digit code from your authenticator app.'
          : 'Enter one of your saved backup codes.'
      }
    >
      {error ? (
        <Alert tone="destructive" role="alert" title="We couldn’t verify that code">
          {error}
        </Alert>
      ) : null}

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <Field id="code" label={isTotp ? 'Authentication code' : 'Backup code'}>
          {(props) => (
            <Input
              {...props}
              ref={codeRef}
              // TOTP codes are numeric; backup codes may include letters.
              type="text"
              autoComplete="one-time-code"
              inputMode={isTotp ? 'numeric' : 'text'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={pending}
            />
          )}
        </Field>

        <Button type="submit" disabled={pending}>
          {pending ? 'Verifying…' : 'Verify'}
        </Button>
      </form>

      <button
        type="button"
        onClick={() => switchMode(isTotp ? 'backup' : 'totp')}
        className="text-primary text-sm font-medium underline underline-offset-4"
      >
        {isTotp ? 'Use a backup code instead' : 'Use your authenticator app instead'}
      </button>

      <p className="text-muted-foreground text-center text-sm">
        <Link
          href="/sign-in"
          className="text-primary font-medium underline underline-offset-4"
        >
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
