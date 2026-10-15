'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient, passkey, twoFactor, useSession } from '@/lib/auth/client';

/**
 * Account security controls: two-step verification (TOTP) enrolment and passkey
 * management. All state is initiated from the browser client; every privileged
 * decision is re-made and audited on the server.
 *
 * The component is gated on an authenticated session — an unauthenticated
 * visitor is shown a sign-in prompt rather than any controls.
 *
 * TOTP secret display: rather than pull in a QR-rendering dependency, we show
 * the `otpauth://` provisioning URI and the extracted secret for manual entry
 * into an authenticator app. Backup codes are shown ONCE, immediately after
 * enabling, and never again.
 */

/** A passkey as returned by the auth client's list endpoint. */
type UserPasskey = {
  id: string;
  name?: string | undefined;
  createdAt: Date | string;
};

/** Pull the `secret` query parameter out of an otpauth:// provisioning URI. */
function extractSecret(totpURI: string): string | null {
  try {
    const url = new URL(totpURI);
    return url.searchParams.get('secret');
  } catch {
    // Fall back to a permissive regex if the URI isn't a standard URL.
    const match = /[?&]secret=([^&]+)/i.exec(totpURI);
    return match?.[1] ?? null;
  }
}

export function SecuritySettings() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  if (!session) {
    return (
      <Alert tone="info" title="Sign in required">
        <p>Sign in to manage your account security.</p>
        <p className="mt-2">
          <Link
            href="/sign-in"
            className="text-primary font-medium underline underline-offset-4"
          >
            Go to sign in
          </Link>
        </p>
      </Alert>
    );
  }

  const twoFactorEnabled = session.user.twoFactorEnabled ?? false;

  return (
    <div className="flex flex-col gap-6">
      <TwoFactorSection enabled={twoFactorEnabled} />
      <PasskeySection />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Two-step verification (TOTP)                                               */
/* -------------------------------------------------------------------------- */

type TotpStage =
  | { kind: 'idle' }
  | { kind: 'enrolling'; totpURI: string; secret: string | null; backupCodes: string[] }
  | { kind: 'enabled'; backupCodes: string[] };

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<TotpStage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const codeRef = useRef<HTMLInputElement>(null);

  async function handleEnable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const { data, error: enableError } = await twoFactor.enable({
      password,
      method: 'totp',
    });
    setBusy(false);

    // Only authenticator-app enrolment is supported; any other method in the
    // response is unexpected, so fail closed rather than show a partial setup.
    if (enableError || !data || data.method !== 'totp') {
      setError(
        'We couldn’t start two-step verification. Check your password and try again.',
      );
      return;
    }

    setPassword('');
    setStage({
      kind: 'enrolling',
      totpURI: data.totpURI,
      secret: extractSecret(data.totpURI),
      backupCodes: data.backupCodes,
    });
  }

  async function handleConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage.kind !== 'enrolling') return;
    setError(null);
    setBusy(true);

    const { error: verifyError } = await twoFactor.verifyTotp({ code: code.trim() });
    setBusy(false);

    if (verifyError) {
      setError('That code didn’t match. Check your authenticator app and try again.');
      codeRef.current?.focus();
      return;
    }

    setCode('');
    // Keep the backup codes visible one final time now that 2FA is active.
    setStage({ kind: 'enabled', backupCodes: stage.backupCodes });
  }

  async function handleDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const { error: disableError } = await twoFactor.disable({ password });
    setBusy(false);

    if (disableError) {
      setError(
        'We couldn’t turn off two-step verification. Check your password and try again.',
      );
      return;
    }

    setPassword('');
    setStage({ kind: 'idle' });
    // Reflect the change without a full reload.
    window.location.reload();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-step verification</CardTitle>
        <p className="text-muted-foreground text-sm">
          Require a code from an authenticator app when you sign in.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <Alert tone="destructive" role="alert" title="Something went wrong">
            {error}
          </Alert>
        ) : null}

        {/* Enrolment: enter password to begin. */}
        {!enabled && stage.kind === 'idle' ? (
          <form className="flex flex-col gap-4" onSubmit={handleEnable} noValidate>
            <Field id="totp-enable-password" label="Confirm your password to continue">
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                />
              )}
            </Field>
            <Button type="submit" disabled={busy || password.length === 0}>
              {busy ? 'Starting…' : 'Set up two-step verification'}
            </Button>
          </form>
        ) : null}

        {/* Enrolment: show URI/secret + confirm with a code. */}
        {stage.kind === 'enrolling' ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="text-foreground text-sm font-medium">
                1. Add BlakPath to your authenticator app
              </p>
              <p className="text-muted-foreground text-sm">
                Scan the setup link with your app, or enter the secret below by hand.
              </p>
              <div className="border-border bg-surface-muted flex flex-col gap-2 rounded-md border p-3">
                <div>
                  <span className="text-muted-foreground text-xs">Setup link</span>
                  <p className="text-foreground font-mono text-xs break-all">
                    {stage.totpURI}
                  </p>
                </div>
                {stage.secret ? (
                  <div>
                    <span className="text-muted-foreground text-xs">Secret key</span>
                    <p className="text-foreground font-mono text-sm break-all">
                      {stage.secret}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>

            <BackupCodes codes={stage.backupCodes} />

            <form className="flex flex-col gap-4" onSubmit={handleConfirm} noValidate>
              <Field id="totp-confirm-code" label="2. Enter the 6-digit code to confirm">
                {(props) => (
                  <Input
                    {...props}
                    ref={codeRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    disabled={busy}
                  />
                )}
              </Field>
              <Button type="submit" disabled={busy || code.trim().length === 0}>
                {busy ? 'Confirming…' : 'Confirm and turn on'}
              </Button>
            </form>
          </div>
        ) : null}

        {/* Just enabled: final look at backup codes. */}
        {stage.kind === 'enabled' ? (
          <div className="flex flex-col gap-4">
            <Alert tone="success" title="Two-step verification is on">
              You’ll be asked for a code from your authenticator app next time you sign
              in.
            </Alert>
            <BackupCodes codes={stage.backupCodes} />
            <Button
              type="button"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Done
            </Button>
          </div>
        ) : null}

        {/* Already enabled: offer to disable. */}
        {enabled && stage.kind === 'idle' ? (
          <form className="flex flex-col gap-4" onSubmit={handleDisable} noValidate>
            <Alert tone="success" title="Two-step verification is on">
              Your account is protected with an authenticator app.
            </Alert>
            <Field
              id="totp-disable-password"
              label="Confirm your password to turn this off"
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                />
              )}
            </Field>
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || password.length === 0}
            >
              {busy ? 'Turning off…' : 'Turn off two-step verification'}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One-time display of recovery/backup codes. */
function BackupCodes({ codes }: { codes: string[] }) {
  if (codes.length === 0) return null;
  return (
    <Alert tone="warning" title="Save your backup codes now">
      <p className="text-sm">
        Store these somewhere safe. Each code can be used once if you lose access to your
        authenticator app. You won’t be able to see them again.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-sm">
        {codes.map((backupCode) => (
          <li key={backupCode} className="text-foreground">
            {backupCode}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/* -------------------------------------------------------------------------- */
/* Passkeys                                                                    */
/* -------------------------------------------------------------------------- */

function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
  }).format(date);
}

function PasskeySection() {
  const [passkeys, setPasskeys] = useState<UserPasskey[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error: listError } = await authClient.passkey.listUserPasskeys();
    setLoading(false);
    if (listError || !data) {
      setError('We couldn’t load your passkeys. Try refreshing the page.');
      return;
    }
    setError(null);
    setPasskeys(data as UserPasskey[]);
  }, []);

  useEffect(() => {
    // Load the user's passkeys on mount. `refresh` awaits a fetch before it sets
    // state, so this is a deferred load, not a synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const trimmed = name.trim();
    const result = await passkey.addPasskey(trimmed.length > 0 ? { name: trimmed } : {});
    setBusy(false);

    if (result?.error) {
      setError(
        'We couldn’t add that passkey. Your device may have cancelled the request — try again.',
      );
      return;
    }

    setName('');
    await refresh();
  }

  async function handleRemove(id: string) {
    setError(null);
    setBusy(true);
    const { error: deleteError } = await authClient.passkey.deletePasskey({ id });
    setBusy(false);
    if (deleteError) {
      setError('We couldn’t remove that passkey. Please try again.');
      return;
    }
    await refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <p className="text-muted-foreground text-sm">
          Sign in without a password using your device’s screen lock or a security key.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <Alert tone="destructive" role="alert" title="Something went wrong">
            {error}
          </Alert>
        ) : null}

        {loading ? (
          <p className="text-muted-foreground text-sm">Loading your passkeys…</p>
        ) : passkeys.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            You don’t have any passkeys yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {passkeys.map((item) => {
              const created = formatDate(item.createdAt);
              return (
                <li
                  key={item.id}
                  className="border-border flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <p className="text-foreground truncate text-sm font-medium">
                      {item.name && item.name.length > 0 ? item.name : 'Passkey'}
                    </p>
                    {created ? (
                      <p className="text-muted-foreground text-xs">Added {created}</p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(item.id)}
                    disabled={busy}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <form className="flex flex-col gap-4" onSubmit={handleAdd} noValidate>
          <Field
            id="passkey-name"
            label="Passkey name"
            description="Give it a name so you can recognise it later (for example, “Work laptop”)."
          >
            {(props) => (
              <Input
                {...props}
                type="text"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            )}
          </Field>
          <Button type="submit" variant="outline" disabled={busy}>
            {busy ? 'Working…' : 'Add a passkey'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
