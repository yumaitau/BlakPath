'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StepUpDialog, useStepUp } from '@/components/auth/step-up-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { staffJson } from '@/components/staff-tools/request';
import {
  humanStatus,
  nativeSelectClass,
} from '@/components/staff-tools/staff-tool-frame';

export interface RetentionPolicyItem {
  id: string;
  resourceType: string;
  /** Null means permanent retention. */
  retentionDays: number | null;
  action: string;
  active: boolean;
}

export interface LegalHoldItem {
  id: string;
  resourceType: string;
  resourceId: string;
  reason: string;
  releasedAt: string | null;
}

/** Jurisdiction keys the API accepts. The records manager chooses; the software does not. */
const JURISDICTIONS = [
  { value: 'organisation', label: 'Organisation schedule' },
  { value: 'nsw', label: 'New South Wales' },
  { value: 'vic', label: 'Victoria' },
  { value: 'qld', label: 'Queensland' },
  { value: 'wa', label: 'Western Australia' },
  { value: 'sa', label: 'South Australia' },
  { value: 'tas', label: 'Tasmania' },
  { value: 'act', label: 'Australian Capital Territory' },
  { value: 'nt', label: 'Northern Territory' },
  { value: 'cth', label: 'Commonwealth' },
] as const;

const RESOURCE_TYPES = [
  { value: 'application', label: 'Applications' },
  { value: 'evidence', label: 'Evidence' },
  { value: 'form_response', label: 'Form responses' },
] as const;

export function RetentionPanel({
  policies,
  holds,
}: {
  policies: readonly RetentionPolicyItem[];
  holds: readonly LegalHoldItem[];
}) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [resourceType, setResourceType] =
    useState<(typeof RESOURCE_TYPES)[number]['value']>('application');
  const [retentionDays, setRetentionDays] = useState('365');
  const [action, setAction] = useState<'purge' | 'anonymise'>('anonymise');
  const [jurisdiction, setJurisdiction] =
    useState<(typeof JURISDICTIONS)[number]['value']>('organisation');
  const [authorityReference, setAuthorityReference] = useState('');
  const [holdType, setHoldType] =
    useState<(typeof RESOURCE_TYPES)[number]['value']>('application');
  const [resourceId, setResourceId] = useState('');
  const [reason, setReason] = useState('');
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
    <div className="grid gap-10">
      <StepUpDialog open={stepUp.open} onFinish={stepUp.finish} />
      {error ? (
        <Alert role="alert" tone="destructive" title="Retention change not saved">
          {error}
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            'policy',
            async () => {
              await staffJson('/api/retention/policies', 'POST', {
                resourceType,
                retentionDays: Number(retentionDays),
                action,
                jurisdiction,
                ...(authorityReference.trim()
                  ? { authorityReference: authorityReference.trim() }
                  : {}),
              });
            },
            'Retention policy drafted. A different person must activate it before a sweep applies it. A legal hold stops a record from being touched.',
          );
        }}
      >
        <h2 className="text-lg font-semibold">Retention policy</h2>
        <div className="grid gap-2">
          <Label htmlFor="policy-record-type">Policy record type</Label>
          <select
            id="policy-record-type"
            className={nativeSelectClass}
            value={resourceType}
            onChange={(event) =>
              setResourceType(
                event.target.value as (typeof RESOURCE_TYPES)[number]['value'],
              )
            }
          >
            {RESOURCE_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <Field
          id="retention-days"
          label="Keep for days"
          required
          description="At least 30 days."
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              min={30}
              value={retentionDays}
              onChange={(event) => setRetentionDays(event.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-2">
          <Label htmlFor="retention-action">Action after that time</Label>
          <select
            id="retention-action"
            className={nativeSelectClass}
            value={action}
            onChange={(event) => setAction(event.target.value as 'purge' | 'anonymise')}
          >
            <option value="anonymise">Anonymise</option>
            <option value="purge">Purge</option>
          </select>
          <p className="text-muted-foreground text-sm">
            The audit trail is never removed by a retention policy.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="retention-jurisdiction">Records jurisdiction</Label>
          <select
            id="retention-jurisdiction"
            className={nativeSelectClass}
            value={jurisdiction}
            onChange={(event) =>
              setJurisdiction(
                event.target.value as (typeof JURISDICTIONS)[number]['value'],
              )
            }
          >
            {JURISDICTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <Field
          id="retention-authority"
          label="Disposal authority reference"
          description="Required for a purge. It must match the authority a records manager signed for this class."
        >
          {(props) => (
            <Input
              {...props}
              value={authorityReference}
              onChange={(event) => setAuthorityReference(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={busy !== null}>
          {busy === 'policy' ? 'Saving…' : 'Save retention policy'}
        </Button>
      </form>

      <section aria-labelledby="policy-list-heading">
        <h2 id="policy-list-heading" className="text-lg font-semibold">
          Policies
        </h2>
        {policies.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">No retention policies yet.</p>
        ) : (
          <ul className="divide-border mt-3 divide-y">
            {policies.map((policy) => (
              <li
                key={policy.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-sm">
                  {humanStatus(policy.resourceType)} ·{' '}
                  {policy.retentionDays === null
                    ? 'permanent'
                    : `${policy.retentionDays} days`}{' '}
                  · {humanStatus(policy.action)}
                  {policy.active ? '' : ' · awaiting activation'}
                </span>
                {policy.active ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      void run(
                        `activate-${policy.id}`,
                        () =>
                          staffJson(
                            `/api/retention/policies/${policy.id}/activate`,
                            'POST',
                            undefined,
                            () => stepUp.request(),
                          ),
                        'Retention policy activated.',
                      );
                    }}
                  >
                    {busy === `activate-${policy.id}`
                      ? 'Activating…'
                      : `Activate ${humanStatus(policy.resourceType)} policy`}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => {
                    void run(
                      policy.id,
                      () =>
                        staffJson(
                          `/api/retention/policies/${policy.id}`,
                          'DELETE',
                          undefined,
                          () => stepUp.request(),
                        ),
                      'Retention policy removed.',
                    );
                  }}
                >
                  {busy === policy.id
                    ? 'Removing…'
                    : `Remove ${humanStatus(policy.resourceType)} policy`}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            'hold',
            async () => {
              await staffJson('/api/retention/holds', 'POST', {
                resourceType: holdType,
                resourceId,
                reason,
              });
              setResourceId('');
              setReason('');
            },
            'Legal hold placed. Retention will not act on that record while the hold stands.',
          );
        }}
      >
        <h2 className="text-lg font-semibold">Legal hold</h2>
        <div className="grid gap-2">
          <Label htmlFor="hold-record-type">Hold record type</Label>
          <select
            id="hold-record-type"
            className={nativeSelectClass}
            value={holdType}
            onChange={(event) =>
              setHoldType(event.target.value as (typeof RESOURCE_TYPES)[number]['value'])
            }
          >
            {RESOURCE_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <Field
          id="hold-record-id"
          label="Record ID"
          required
          description="The identifier of the application, evidence file or form response to protect."
        >
          {(props) => (
            <Input
              {...props}
              value={resourceId}
              onChange={(event) => setResourceId(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <div className="grid gap-2">
          <Label htmlFor="hold-reason">Reason for the hold</Label>
          <Textarea
            id="hold-reason"
            value={reason}
            required
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy !== null}>
          {busy === 'hold' ? 'Placing…' : 'Place hold'}
        </Button>
      </form>

      <section aria-labelledby="hold-list-heading">
        <h2 id="hold-list-heading" className="text-lg font-semibold">
          Holds
        </h2>
        {holds.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">No legal holds yet.</p>
        ) : (
          <ul className="divide-border mt-3 divide-y">
            {holds.map((hold) => (
              <li key={hold.id} className="flex flex-col gap-2 py-3">
                <p className="text-sm font-medium">
                  {humanStatus(hold.resourceType)} ·{' '}
                  {hold.releasedAt ? 'Released' : 'Holding'}
                </p>
                <p className="text-sm">{hold.reason}</p>
                <p className="text-muted-foreground text-xs break-all">
                  {hold.resourceId}
                </p>
                {hold.releasedAt ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      void run(
                        hold.id,
                        () =>
                          staffJson(
                            `/api/retention/holds/${hold.id}`,
                            'DELETE',
                            undefined,
                            () => stepUp.request(),
                          ),
                        'Legal hold released.',
                      );
                    }}
                  >
                    {busy === hold.id ? 'Releasing…' : 'Release hold'}
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
