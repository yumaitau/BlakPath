'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { signIn } from '@/lib/auth/client';

/**
 * Email + password sign-in.
 *
 * On success we redirect to `/dashboard`. If the account has two-factor
 * enabled, the better-auth client's `onTwoFactorRedirect` hook takes over and
 * routes to `/sign-in/two-factor`, so we do not navigate ourselves in that
 * case — we simply keep the button in its pending state until the redirect
 * happens.
 *
 * Error copy is deliberately generic: we never reveal whether an email address
 * has an account, only that the details didn't match.
 */

const GENERIC_ERROR =
  'Those sign-in details didn’t match. Check your email and password and try again.';

/** Keep invitation sign-in continuity without accepting arbitrary redirect URLs. */
function safeReturnPath(): string {
  const requested = new URLSearchParams(window.location.search).get('returnTo');
  return requested && /^\/join\/[A-Za-z0-9_-]{20,200}$/.test(requested)
    ? requested
    : '/dashboard';
}

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (error) emailRef.current?.focus();
  }, [error]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const returnPath = safeReturnPath();
    const { error: signInError } = await signIn.email({
      email,
      password,
      rememberMe,
      callbackURL: returnPath,
    });

    if (signInError) {
      setError(GENERIC_ERROR);
      setPending(false);
      return;
    }

    // Success without a two-factor step: navigate ourselves. When two-factor
    // is owed, the client hook redirects to /sign-in/two-factor instead.
    window.location.href = returnPath;
  }

  async function handlePasskey() {
    setError(null);
    setPasskeyPending(true);

    const result = await signIn.passkey();

    if (result?.error) {
      setError(
        'We couldn’t sign you in with a passkey. Try again, or use your password.',
      );
      setPasskeyPending(false);
      return;
    }

    window.location.href = safeReturnPath();
  }

  return (
    <AuthCard title="Sign in" subtitle="Sign in to your organisation to continue.">
      {error ? (
        <Alert tone="destructive" role="alert" title="We couldn’t sign you in">
          {error}
        </Alert>
      ) : null}

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <Field id="email" label="Email">
          {(props) => (
            <Input
              {...props}
              ref={emailRef}
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
            />
          )}
        </Field>

        <Field id="password" label="Password">
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
            />
          )}
        </Field>

        <div className="flex items-center justify-between gap-3">
          <label className="text-foreground flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="border-input text-primary focus-visible:ring-ring size-4 rounded"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              disabled={pending}
            />
            Remember me
          </label>

          <Link
            href="/forgot-password"
            className="text-primary text-sm font-medium underline underline-offset-4"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs">or</span>
        <span className="bg-border h-px flex-1" />
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={handlePasskey}
        disabled={passkeyPending}
      >
        {passkeyPending ? 'Waiting for passkey…' : 'Sign in with a passkey'}
      </Button>

      <p className="text-muted-foreground text-center text-sm">
        BlakPath is invite-only. Ask your organisation for an invitation if you
        need access.
      </p>
    </AuthCard>
  );
}
