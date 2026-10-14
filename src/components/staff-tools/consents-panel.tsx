'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { staffJson } from '@/components/staff-tools/request';
import { formatStaffDate, humanStatus } from '@/components/staff-tools/staff-tool-frame';

interface ConsentItem {
  id: string;
  purpose: string;
  status: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  notes: string | null;
}

export function ConsentsPanel({ canWrite }: { canWrite: boolean }) {
  const [subjectUserId, setSubjectUserId] = useState('');
  const [purpose, setPurpose] = useState('representative-access');
  const [expiresAt, setExpiresAt] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<readonly ConsentItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load(subject: string) {
    const response = await fetch(`/api/consents?subject=${encodeURIComponent(subject)}`);
    if (!response.ok) {
      throw new Error(
        response.status === 403
          ? 'Your role does not allow that action, or the record is no longer available.'
          : 'Those consents could not be loaded. Check the account ID and try again.',
      );
    }
    const body = (await response.json()) as { consents: ConsentItem[] };
    setItems(body.consents);
    setLoaded(true);
  }

  return (
    <div className="grid gap-8">
      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy('lookup');
          setError(null);
          setMessage(null);
          try {
            await load(subjectUserId.trim());
          } catch (caught) {
            setError(
              caught instanceof Error
                ? caught.message
                : 'Those consents could not be loaded.',
            );
          } finally {
            setBusy(null);
          }
        }}
      >
        <Field
          id="consent-subject"
          label="Account ID of the person"
          required
          description="Consent is looked up for one person at a time. Agreement is never inferred."
        >
          {(props) => (
            <Input
              {...props}
              value={subjectUserId}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setSubjectUserId(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="outline" disabled={busy !== null}>
          {busy === 'lookup' ? 'Loading…' : 'Show consents'}
        </Button>
      </form>

      {canWrite ? (
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy('record');
            setError(null);
            setMessage(null);
            try {
              await staffJson('/api/consents', 'POST', {
                subjectUserId: subjectUserId.trim(),
                purpose: purpose.trim(),
                ...(expiresAt
                  ? { expiresAt: new Date(`${expiresAt}T00:00:00`).toISOString() }
                  : {}),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
              });
              setNotes('');
              setMessage('Consent recorded.');
              await load(subjectUserId.trim());
            } catch (caught) {
              setError(
                caught instanceof Error ? caught.message : 'That could not be saved.',
              );
            } finally {
              setBusy(null);
            }
          }}
        >
          <h2 className="text-lg font-semibold">Record a grant</h2>
          <Field
            id="consent-purpose"
            label="Purpose"
            required
            description="Use representative-access when this grant will back a representative. Other purposes are stored exactly as written."
          >
            {(props) => (
              <Input
                {...props}
                value={purpose}
                maxLength={200}
                onChange={(event) => setPurpose(event.target.value)}
              />
            )}
          </Field>
          <div className="grid gap-2">
            <Label htmlFor="consent-expires">Expires on (optional)</Label>
            <Input
              id="consent-expires"
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="consent-notes">Notes (optional)</Label>
            <Textarea
              id="consent-notes"
              value={notes}
              maxLength={2000}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy !== null}>
            {busy === 'record' ? 'Recording…' : 'Record consent'}
          </Button>
        </form>
      ) : null}

      {error ? (
        <Alert role="alert" tone="destructive" title="Consent not updated">
          {error}
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <section aria-labelledby="consent-list-heading">
        <h2 id="consent-list-heading" className="text-lg font-semibold">
          Recorded consents
        </h2>
        {!loaded ? (
          <p className="text-muted-foreground mt-2 text-sm">
            Enter an account ID and choose Show consents.
          </p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">
            No consents recorded for that person.
          </p>
        ) : (
          <ul className="divide-border mt-3 divide-y">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 py-3">
                <p className="text-sm font-medium">
                  {item.purpose} · {humanStatus(item.status)}
                </p>
                <p className="text-muted-foreground text-xs">
                  Granted {formatStaffDate(item.grantedAt)}
                  {item.expiresAt ? ` · expires ${formatStaffDate(item.expiresAt)}` : ''}
                  {item.revokedAt
                    ? ` · withdrawn ${formatStaffDate(item.revokedAt)}`
                    : ''}
                </p>
                {item.notes ? <p className="text-sm">{item.notes}</p> : null}
                <p className="text-muted-foreground text-xs break-all">
                  Record {item.id}
                </p>
                {canWrite && item.status === 'granted' && !item.revokedAt ? (
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
                          await staffJson(`/api/consents/${item.id}`, 'DELETE');
                          setMessage('Consent withdrawn.');
                          await load(subjectUserId.trim());
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
                    {busy === item.id ? 'Withdrawing…' : `Withdraw ${item.purpose}`}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
