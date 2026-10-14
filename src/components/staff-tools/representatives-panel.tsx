'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { staffJson } from '@/components/staff-tools/request';
import { formatStaffDate, humanStatus } from '@/components/staff-tools/staff-tool-frame';

export interface RepresentativeItem {
  id: string;
  subjectUserId: string;
  representativeUserId: string;
  purpose: string;
  status: string;
  expiresAt: string | null;
  consentRecordId: string | null;
}

export function RepresentativesPanel({
  items,
}: {
  items: readonly RepresentativeItem[];
}) {
  const router = useRouter();
  const [subjectUserId, setSubjectUserId] = useState('');
  const [representativeUserId, setRepresentativeUserId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [consentRecordId, setConsentRecordId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(key: string, task: () => Promise<void>, success: string) {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      await task();
      setMessage(success);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-8">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            'request',
            async () => {
              await staffJson('/api/representatives', 'POST', {
                subjectUserId: subjectUserId.trim(),
                representativeUserId: representativeUserId.trim(),
                purpose: purpose.trim(),
                consentRecordId: consentRecordId.trim(),
                ...(expiresAt
                  ? { expiresAt: new Date(`${expiresAt}T00:00:00`).toISOString() }
                  : {}),
              });
              setPurpose('');
              setConsentRecordId('');
            },
            'Representative access requested. It stays pending until you activate it.',
          );
        }}
      >
        <Field
          id="rep-subject"
          label="Account ID of the person being represented"
          required
          description="Access is refused unless a live consent grant with purpose representative-access exists for this person."
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
        <Field id="rep-user" label="Account ID of the representative" required>
          {(props) => (
            <Input
              {...props}
              value={representativeUserId}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setRepresentativeUserId(event.target.value)}
            />
          )}
        </Field>
        <Field
          id="rep-purpose"
          label="Why this person may act"
          required
          description="Up to 500 characters. This does not replace the consent purpose."
        >
          {(props) => (
            <Input
              {...props}
              value={purpose}
              maxLength={500}
              onChange={(event) => setPurpose(event.target.value)}
            />
          )}
        </Field>
        <Field
          id="rep-consent"
          label="Consent record ID"
          required
          description="Copy this from the Consents screen after the grant is recorded."
        >
          {(props) => (
            <Input
              {...props}
              value={consentRecordId}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setConsentRecordId(event.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-2">
          <Label htmlFor="rep-expires">Access expires on (optional)</Label>
          <Input
            id="rep-expires"
            type="date"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy !== null}>
          {busy === 'request' ? 'Requesting…' : 'Request representative access'}
        </Button>
      </form>

      {error ? (
        <Alert role="alert" tone="destructive" title="Representative access not updated">
          {error}
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <section aria-labelledby="rep-list-heading">
        <h2 id="rep-list-heading" className="text-lg font-semibold">
          Authorisations
        </h2>
        {items.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">
            No representative authorisations yet.
          </p>
        ) : (
          <ul className="mt-3 grid gap-4">
            {items.map((item) => (
              <li key={item.id} className="border-border rounded-lg border p-4">
                <p className="text-sm font-medium">
                  {humanStatus(item.status)} · {item.purpose}
                </p>
                <p className="text-muted-foreground mt-1 text-xs break-all">
                  Person {item.subjectUserId}
                </p>
                <p className="text-muted-foreground text-xs break-all">
                  Representative {item.representativeUserId}
                </p>
                {item.expiresAt ? (
                  <p className="text-muted-foreground text-xs">
                    Expires {formatStaffDate(item.expiresAt)}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.status === 'pending' ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => {
                        void run(
                          `activate:${item.id}`,
                          () =>
                            staffJson(`/api/representatives/${item.id}`, 'PATCH', {
                              operation: 'activate',
                            }),
                          'Representative access activated.',
                        );
                      }}
                    >
                      {busy === `activate:${item.id}` ? 'Activating…' : 'Activate access'}
                    </Button>
                  ) : null}
                  {item.status === 'revoked' || item.status === 'expired' ? null : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => {
                        void run(
                          `revoke:${item.id}`,
                          () =>
                            staffJson(`/api/representatives/${item.id}`, 'PATCH', {
                              operation: 'revoke',
                            }),
                          'Representative access revoked.',
                        );
                      }}
                    >
                      {busy === `revoke:${item.id}` ? 'Revoking…' : 'Revoke access'}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
