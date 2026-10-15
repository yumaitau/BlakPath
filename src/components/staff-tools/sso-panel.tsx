'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StepUpDialog, useStepUp } from '@/components/auth/step-up-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { staffJson } from '@/components/staff-tools/request';

export interface SsoProviderItem {
  id: string;
  providerKey: string;
  issuer: string;
  clientId: string;
  domain: string;
  enabled: boolean;
}

export function SsoPanel({ items }: { items: readonly SsoProviderItem[] }) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [providerKey, setProviderKey] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="grid gap-8">
      <StepUpDialog open={stepUp.open} onFinish={stepUp.finish} />
      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy('create');
          setError(null);
          setMessage(null);
          try {
            await staffJson(
              '/api/sso/providers',
              'POST',
              { providerKey, issuer, clientId, domain },
              () => stepUp.request(),
            );
            setProviderKey('');
            setIssuer('');
            setClientId('');
            setDomain('');
            setMessage('Sign-in connection saved. It stays off until you enable it.');
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
          id="sso-provider"
          label="Provider key"
          required
          description="The registered provider name, for example entra."
        >
          {(props) => (
            <Input
              {...props}
              value={providerKey}
              maxLength={100}
              onChange={(event) => setProviderKey(event.target.value)}
            />
          )}
        </Field>
        <Field
          id="sso-issuer"
          label="Issuer URL"
          required
          description="The identity provider's issuer address."
        >
          {(props) => (
            <Input
              {...props}
              type="url"
              inputMode="url"
              value={issuer}
              onChange={(event) => setIssuer(event.target.value)}
            />
          )}
        </Field>
        <Field
          id="sso-client"
          label="Client ID"
          required
          description="The public client identifier. Secrets stay in your secret store, not here."
        >
          {(props) => (
            <Input
              {...props}
              value={clientId}
              maxLength={300}
              onChange={(event) => setClientId(event.target.value)}
            />
          )}
        </Field>
        <Field
          id="sso-domain"
          label="Email domain"
          required
          description="People with this email domain are offered this sign-in. Enabling needs the domain verified for your organisation."
        >
          {(props) => (
            <Input
              {...props}
              value={domain}
              maxLength={253}
              autoComplete="off"
              onChange={(event) => setDomain(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={busy !== null}>
          {busy === 'create' ? 'Saving…' : 'Add sign-in connection'}
        </Button>
      </form>

      {error ? (
        <Alert role="alert" tone="destructive" title="Sign-in connection not saved">
          {error}
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <section aria-labelledby="sso-list-heading">
        <h2 id="sso-list-heading" className="text-lg font-semibold">
          Connections
        </h2>
        {items.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">
            No sign-in connections yet.
          </p>
        ) : (
          <ul className="divide-border mt-3 divide-y">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  <span className="block text-sm font-medium">
                    {item.providerKey} · {item.domain}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {item.enabled ? 'Enabled' : 'Off'} · {item.issuer}
                  </span>
                </span>
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
                        await staffJson(`/api/sso/providers/${item.id}`, 'PATCH', {
                          enabled: !item.enabled,
                        });
                        setMessage(
                          item.enabled
                            ? `${item.providerKey} turned off.`
                            : `${item.providerKey} enabled.`,
                        );
                        router.refresh();
                      } catch (caught) {
                        setError(
                          item.enabled
                            ? caught instanceof Error
                              ? caught.message
                              : 'That could not be saved.'
                            : 'That connection could not be enabled. The email domain must already be verified for this organisation.',
                        );
                      } finally {
                        setBusy(null);
                      }
                    })();
                  }}
                >
                  {busy === item.id
                    ? 'Saving…'
                    : item.enabled
                      ? `Turn off ${item.providerKey}`
                      : `Enable ${item.providerKey}`}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
