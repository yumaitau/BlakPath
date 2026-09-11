'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { MembershipInvitationPreview } from '@/domains/memberships';

export function MembershipInvitationAcceptance({
  token,
  preview,
  signedIn,
  signedInEmail,
  emailVerified,
}: {
  token: string;
  preview: MembershipInvitationPreview | null;
  signedIn: boolean;
  signedInEmail: string | null;
  emailVerified: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  async function createAccount() {
    if (!name.trim() || password.length < 12) {
      setError('Enter your name and a password of at least 12 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await fetch('/api/membership-invitations/create-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name: name.trim(), password }),
      });
      if (!created.ok) {
        setError(
          'This account could not be created. You may already have one — try signing in instead, or ask the organisation for a new invitation.',
        );
        return;
      }
      window.location.assign(`/sign-in?returnTo=${encodeURIComponent(`/join/${token}`)}`);
    } catch {
      setError('We could not reach the service. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function accept() {    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/membership-invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        setError(
          'This invitation could not be accepted. Sign in with the verified email address it was sent to, or ask the organisation to send a new invitation.',
        );
        return;
      }
      window.location.assign('/dashboard');
    } catch {
      setError('We could not reach the service. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!preview) {
    return (
      <Alert tone="warning" title="This invitation is no longer available">
        It may have expired, been cancelled, already been accepted, or been replaced by a
        newer invitation. Ask the organisation to send a new one.
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Join {preview.organisationName}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div>
          <p>
            You have been invited to join as{' '}
            <span className="font-semibold">{preview.roleName}</span>.
          </p>
          <p className="text-muted-foreground mt-2 text-sm">
            This invitation is restricted to {preview.emailHint} and grants access only to{' '}
            {preview.organisationName}.
          </p>
        </div>

        {error ? (
          <Alert tone="destructive" role="alert">
            {error}
          </Alert>
        ) : null}

        {!signedIn ? (
          <div className="grid gap-4">
            <Alert tone="info" title="Sign in to continue">
              <p>
                Sign in with the email address that received this invitation, then
                reopen this link. New here? Create your account below — the
                invitation itself verifies your email, so no separate signup is
                needed.
              </p>
              <div className="mt-4">
                <Button asChild size="sm">
                  <Link href={`/sign-in?returnTo=${encodeURIComponent(`/join/${token}`)}`}>
                    Sign in
                  </Link>
                </Button>
              </div>
            </Alert>
            <form
              aria-label="Create account for this invitation"
              onSubmit={(e) => {
                e.preventDefault();
                void createAccount();
              }}
              className="grid gap-3 rounded-lg border p-4"
            >
              <h3 className="font-semibold">Create your account</h3>
              <div className="grid gap-1">
                <label htmlFor="invite-name" className="text-xs font-medium">
                  Your name
                </label>
                <input
                  id="invite-name"
                  className="rounded border px-2 py-1.5 text-sm"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </div>
              <div className="grid gap-1">
                <label htmlFor="invite-password" className="text-xs font-medium">
                  Password (at least 12 characters)
                </label>
                <input
                  id="invite-password"
                  type="password"
                  className="rounded border px-2 py-1.5 text-sm"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? 'Creating…' : 'Create account and continue'}
              </Button>
            </form>
          </div>
        ) : !emailVerified ? (
          <Alert tone="warning" title="Verify your email first">
            This invitation cannot grant access until {signedInEmail} has been verified.
          </Alert>
        ) : (
          <div>
            <p className="text-muted-foreground mb-3 text-sm">
              Signed in as {signedInEmail}. Accepting activates the role shown above; an
              organisation administrator can change or remove it later.
            </p>
            <Button onClick={() => void accept()} disabled={busy}>
              {busy ? 'Joining…' : `Join ${preview.organisationName}`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
