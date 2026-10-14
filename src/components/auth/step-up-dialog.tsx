'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from '@/lib/auth/client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Inline re-authentication. Password (plus an authenticator code when one is
 * enrolled) or a passkey mints a fresh session. Cancel leaves the current
 * session in place. This dialog never signs the person out.
 */

export function useStepUp(): {
  open: boolean;
  request: () => Promise<boolean>;
  finish: (ok: boolean) => void;
} {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const request = useCallback(() => {
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(ok);
  }, []);

  return { open, request, finish };
}

export function StepUpDialog({
  open,
  onFinish,
}: {
  open: boolean;
  onFinish: (ok: boolean) => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const codeId = useId();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setPassword('');
      setCode('');
      setUseBackup(false);
      setNeedsCode(false);
      setError(null);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/step-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          totpCode: useBackup ? undefined : code.trim() || undefined,
          backupCode: useBackup ? code.trim() || undefined : undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { code?: string };
      if (response.ok) {
        onFinish(true);
        return;
      }
      if (data.code === 'SESSION_EXPIRED') {
        router.push('/sign-in');
        return;
      }
      if (data.code === 'TOTP_REQUIRED') {
        setNeedsCode(true);
        setError('Enter the code from your authenticator, or a backup code.');
        return;
      }
      setError('That did not match. Try again.');
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setPending(false);
    }
  }

  async function submitPasskey() {
    setPending(true);
    setError(null);
    try {
      const prepared = await fetch('/api/session/step-up/prepare', { method: 'POST' });
      if (!prepared.ok) {
        setError('The passkey check could not start. Try again.');
        return;
      }
      const signedIn = await signIn.passkey();
      if (signedIn.error) {
        setError('The passkey was not accepted.');
        return;
      }
      const completed = await fetch('/api/session/step-up/complete', { method: 'POST' });
      if (!completed.ok) {
        setError('The passkey was accepted, but the session could not be confirmed.');
        return;
      }
      onFinish(true);
    } catch {
      setError('The passkey check did not finish. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="bg-surface text-foreground w-[min(100%,28rem)] rounded-lg border p-6 shadow-lg backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onFinish(false);
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => void submitPassword(event)}
      >
        <div>
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            Confirm it&apos;s you
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Enter your password to continue. You stay signed in.
          </p>
        </div>
        {error ? <Alert tone="destructive">{error}</Alert> : null}
        <div className="grid gap-2">
          <Label htmlFor={`${titleId}-password`} required>
            Password
          </Label>
          <Input
            id={`${titleId}-password`}
            type="password"
            autoComplete="current-password"
            value={password}
            required
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={codeId}>
            {useBackup ? 'Backup code' : 'Authenticator code'}
          </Label>
          <Input
            id={codeId}
            inputMode={useBackup ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            value={code}
            aria-invalid={needsCode && code.trim().length === 0}
            onChange={(event) => setCode(event.target.value)}
          />
          <button
            type="button"
            className="text-primary justify-self-start text-sm font-semibold underline-offset-4 hover:underline"
            onClick={() => {
              setUseBackup((current) => !current);
              setCode('');
            }}
          >
            {useBackup ? 'Use an authenticator code' : 'Use a backup code'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Checking…' : 'Continue'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onFinish(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => void submitPasskey()}
          >
            Use a passkey
          </Button>
        </div>
      </form>
    </dialog>
  );
}
