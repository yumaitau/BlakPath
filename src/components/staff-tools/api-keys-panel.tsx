'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { staffJson } from '@/components/staff-tools/request';
import { formatStaffDate } from '@/components/staff-tools/staff-tool-frame';

export interface ApiKeyScopeOption {
  key: string;
  description: string;
}

export interface ApiKeyListItem {
  id: string;
  name: string;
  prefix: string;
  scopes: readonly string[];
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function ApiKeysPanel({
  items,
  scopes,
}: {
  items: readonly ApiKeyListItem[];
  scopes: readonly ApiKeyScopeOption[];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState('365');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function toggle(key: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...current, key] : current.filter((item) => item !== key),
    );
  }

  return (
    <div className="grid gap-8">
      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy('create');
          setError(null);
          setMessage(null);
          setSecret(null);
          try {
            const created = await staffJson<{ key: string }>('/api/keys', 'POST', {
              name,
              scopes: selected,
              expiresInDays: Number(expiresInDays),
            });
            setSecret(created.key);
            setName('');
            setSelected([]);
            setMessage(
              'API key created. Copy the secret now. It will not be shown again.',
            );
            router.refresh();
          } catch (caught) {
            setError(
              caught instanceof Error ? caught.message : 'That could not be saved.',
            );
          } finally {
            setBusy(null);
          }
        }}
      >
        <Field
          id="api-key-name"
          label="Key name"
          required
          description="A name your colleagues will recognise."
        >
          {(props) => (
            <Input
              {...props}
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-semibold">Permissions this key may use</legend>
          <p className="text-muted-foreground text-sm">
            A key can only receive permissions you already hold. Choose at least one.
          </p>
          <ul className="grid gap-2">
            {scopes.map((scope) => (
              <li key={scope.key}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 size-4"
                    checked={selected.includes(scope.key)}
                    onChange={(event) => toggle(scope.key, event.target.checked)}
                  />
                  <span>{scope.description}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <Field
          id="api-key-expiry"
          label="Expires in days"
          required
          description="Between 1 and 730 days."
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              max={730}
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={busy !== null || selected.length === 0}>
          {busy === 'create' ? 'Creating…' : 'Create API key'}
        </Button>
      </form>

      {error ? (
        <Alert role="alert" tone="destructive" title="API key not saved">
          {error}
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      {secret ? (
        <Field
          id="api-key-secret"
          label="API key secret"
          description="Shown once. Store it somewhere safe."
        >
          {(props) => <Input {...props} readOnly value={secret} autoFocus />}
        </Field>
      ) : null}

      <section aria-labelledby="api-key-list-heading">
        <h2 id="api-key-list-heading" className="text-lg font-semibold">
          Keys
        </h2>
        {items.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">No API keys yet.</p>
        ) : (
          <ul className="divide-border mt-3 divide-y">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  <span className="block text-sm font-medium">{item.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {item.prefix} · created {formatStaffDate(item.createdAt)}
                    {item.expiresAt
                      ? ` · expires ${formatStaffDate(item.expiresAt)}`
                      : ''}
                    {item.revokedAt
                      ? ` · revoked ${formatStaffDate(item.revokedAt)}`
                      : ''}
                  </span>
                </span>
                {item.revokedAt ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      void (async () => {
                        setBusy(item.id);
                        setError(null);
                        setMessage(null);
                        try {
                          await staffJson(`/api/keys/${item.id}`, 'DELETE');
                          setMessage(`${item.name} revoked.`);
                          router.refresh();
                        } catch (caught) {
                          setError(
                            caught instanceof Error
                              ? caught.message
                              : 'That could not be saved.',
                          );
                        } finally {
                          setBusy(null);
                        }
                      })();
                    }}
                  >
                    {busy === item.id ? 'Revoking…' : `Revoke ${item.name}`}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
