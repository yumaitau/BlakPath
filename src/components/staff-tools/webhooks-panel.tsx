'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StepUpDialog, useStepUp } from '@/components/auth/step-up-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { staffJson } from '@/components/staff-tools/request';
import { formatStaffDate, humanStatus } from '@/components/staff-tools/staff-tool-frame';

export interface WebhookDeliveryItem {
  id: string;
  event: string;
  status: string;
  attempts: number;
  createdAt: string;
}

export interface WebhookEndpointItem {
  id: string;
  url: string;
  events: readonly string[];
  active: boolean;
  deliveries: readonly WebhookDeliveryItem[];
}

const EVENT_OPTIONS = [
  { value: 'application.submitted', label: 'Application submitted' },
  { value: 'decision.finalised', label: 'Decision finalised' },
  { value: 'certificate.signed', label: 'Certificate signed' },
  { value: 'form.response_submitted', label: 'Form response submitted' },
  { value: 'evidence.scan_infected', label: 'Evidence scan found a threat' },
] as const;

export function WebhooksPanel({ items }: { items: readonly WebhookEndpointItem[] }) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<readonly string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
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
          setSecret(null);
          try {
            const created = await staffJson<{ secret: string }>(
              '/api/webhooks',
              'POST',
              { url, events },
              () => stepUp.request(),
            );
            setSecret(created.secret);
            setUrl('');
            setEvents([]);
            setMessage('Webhook saved. Copy the signing secret now.');
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
          id="webhook-url"
          label="Endpoint URL"
          required
          description="An https address that will receive event notices. Notices carry record ids, not personal stories."
        >
          {(props) => (
            <Input
              {...props}
              type="url"
              inputMode="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://"
            />
          )}
        </Field>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-semibold">Events to send</legend>
          <ul className="grid gap-2">
            {EVENT_OPTIONS.map((option) => (
              <li key={option.value}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 size-4"
                    checked={events.includes(option.value)}
                    onChange={(event) =>
                      setEvents((current) =>
                        event.target.checked
                          ? [...current, option.value]
                          : current.filter((item) => item !== option.value),
                      )
                    }
                  />
                  <span>{option.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <Button type="submit" disabled={busy !== null || events.length === 0}>
          {busy === 'create' ? 'Saving…' : 'Add webhook'}
        </Button>
      </form>

      {error ? (
        <Alert role="alert" tone="destructive" title="Webhook not saved">
          {error}
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      {secret ? (
        <Field
          id="webhook-secret"
          label="Signing secret"
          description="Shown once. The receiver uses it to check notices."
        >
          {(props) => <Input {...props} readOnly value={secret} autoFocus />}
        </Field>
      ) : null}

      <section aria-labelledby="webhook-list-heading">
        <h2 id="webhook-list-heading" className="text-lg font-semibold">
          Endpoints
        </h2>
        {items.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">No webhooks yet.</p>
        ) : (
          <ul className="mt-3 grid gap-4">
            {items.map((item) => (
              <li key={item.id} className="border-border rounded-lg border p-4">
                <p className="text-sm font-medium break-all">{item.url}</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {item.events.map((event) => humanStatus(event)).join(', ') ||
                    'No events'}
                  {item.active ? '' : ' · inactive'}
                </p>
                {item.deliveries.length > 0 ? (
                  <ul
                    className="mt-3 space-y-1 text-xs"
                    aria-label={`Recent deliveries for ${item.url}`}
                  >
                    {item.deliveries.map((delivery) => (
                      <li key={delivery.id}>
                        {humanStatus(delivery.event)} · {humanStatus(delivery.status)} ·{' '}
                        {delivery.attempts} attempts ·{' '}
                        {formatStaffDate(delivery.createdAt)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground mt-3 text-xs">No deliveries yet.</p>
                )}
                <Button
                  className="mt-3"
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
                        await staffJson(`/api/webhooks/${item.id}`, 'DELETE');
                        setMessage('Webhook removed.');
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
                  {busy === item.id ? 'Removing…' : 'Remove webhook'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
