import { CheckCircle2, CircleAlert, Lock, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { KeyHealthCheck } from '@/components/encryption/key-health-check';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  CUSTODY_MODE_LABEL,
  CUSTODY_MODE_SUMMARY,
  getKeyCustodyOverview,
  KEY_STATUS_LABEL,
  type KeyCustodyOverview,
  type OrganisationKeyStatus,
} from '@/domains/organisation-keys';
import {
  requireRecentAuth,
  StepUpRequiredError,
  STEP_UP_WINDOWS,
} from '@/lib/auth/session';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { isAuthorizationError } from '@/lib/permissions/errors';
import { TenantContextError } from '@/lib/tenancy/context';

export const metadata: Metadata = {
  title: 'Encryption keys — BlakPath',
};

/** Always read live status; never serve a cached key state. */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<OrganisationKeyStatus, 'success' | 'warning' | 'destructive'> =
  {
    active: 'success',
    disabled: 'warning',
    pending_deletion: 'destructive',
    unavailable: 'destructive',
    pending_validation: 'warning',
  };

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Sydney',
  }).format(value);
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <section
      aria-labelledby="keys-heading"
      className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6"
    >
      <h1 id="keys-heading" className="text-2xl font-semibold tracking-tight">
        Encryption keys
      </h1>
      <p className="text-muted-foreground mt-2">
        The key that protects your organisation&apos;s encrypted records, who holds it,
        and every recorded change to it.{' '}
        <Link href="/key-custody" className="text-primary underline underline-offset-4">
          How key custody works
        </Link>
      </p>
      <div className="mt-8 space-y-8">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-border grid gap-1 border-b py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground text-sm font-medium">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function KeyDetails({ overview }: { overview: KeyCustodyOverview }) {
  const check = overview.lastHealthCheck;
  return (
    <div>
      <h2 className="text-lg font-semibold">Current key</h2>
      <dl className="mt-2">
        <Row label="Custody">
          <p className="font-medium">{CUSTODY_MODE_LABEL[overview.custodyMode]}</p>
          <p className="text-muted-foreground mt-1">
            {CUSTODY_MODE_SUMMARY[overview.custodyMode]}
          </p>
        </Row>
        <Row label="Key ARN">
          <code className="font-mono text-xs break-all">{overview.kmsKeyArn}</code>
          <p className="text-muted-foreground mt-1">
            AWS account {overview.keyAccountId}, region {overview.keyRegion}, version{' '}
            {overview.keyVersion}
          </p>
        </Row>
        <Row label="Status">
          <Badge
            tone={STATUS_TONE[overview.status]}
            icon={overview.status === 'active' ? CheckCircle2 : Lock}
          >
            {KEY_STATUS_LABEL[overview.status]}
          </Badge>
          {overview.status !== 'active' ? (
            <p className="text-muted-foreground mt-2">
              Records are locked while the key is not active. BlakPath did not read them
              and will not show them under another key.
            </p>
          ) : null}
        </Row>
        <Row label="Last health check">
          {check ? (
            <p>
              {formatDateTime(check.at)} —{' '}
              {check.ok ? 'passed' : `failed${check.detail ? ` (${check.detail})` : ''}`}
            </p>
          ) : (
            <p>Not checked yet.</p>
          )}
          <div className="mt-3">
            <KeyHealthCheck unavailable={overview.status === 'unavailable'} />
          </div>
        </Row>
        <Row label="Last rotation">
          {overview.rotatedAt
            ? formatDateTime(overview.rotatedAt)
            : `Not rotated since it was registered on ${formatDateTime(overview.registeredAt)}`}
        </Row>
        <Row label="Escrow">
          {overview.escrow.enrolled ? (
            <>
              <p>An escrow copy is recorded for this key.</p>
              {overview.escrow.custodianNames && overview.escrow.custodianNames.length ? (
                <p className="text-muted-foreground mt-1">
                  Custodians: {overview.escrow.custodianNames.join(', ')}
                </p>
              ) : (
                <p className="text-muted-foreground mt-1">
                  Custodian names are not recorded on this key yet.
                </p>
              )}
            </>
          ) : (
            <p>No escrow copy. Only the key holder can restore access.</p>
          )}
        </Row>
      </dl>
    </div>
  );
}

function CloudTrailSection({ overview }: { overview: KeyCustodyOverview }) {
  const trail = overview.cloudTrail;
  return (
    <div>
      <h2 className="text-lg font-semibold">Key usage in CloudTrail</h2>
      {trail.clientCanQuery ? (
        <>
          <p className="text-muted-foreground mt-2 text-sm">
            Every call BlakPath makes with your key is logged in your AWS account (
            {trail.accountId}). Each call carries your organisation id{' '}
            <code className="font-mono text-xs">{overview.organisationId}</code> and a
            purpose: <code className="font-mono text-xs">field</code> for records,{' '}
            <code className="font-mono text-xs">key_health</code> for checks.
          </p>
          <p className="mt-3 text-sm">
            <a
              href={trail.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4"
            >
              Open CloudTrail event history for this key
            </a>
          </p>
        </>
      ) : (
        <p className="text-muted-foreground mt-2 text-sm">
          This key is in BlakPath&apos;s AWS account ({trail.accountId}). Ask BlakPath
          support for an extract of its CloudTrail events; the command below is the one
          BlakPath runs.
        </p>
      )}
      <p className="text-muted-foreground mt-3 text-sm">From the AWS CLI:</p>
      <pre className="bg-surface-muted mt-1 overflow-x-auto rounded-md p-3 text-xs">
        <code>{trail.cliCommand}</code>
      </pre>
    </div>
  );
}

function HistorySection({ overview }: { overview: KeyCustodyOverview }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">Key change history</h2>
      <p className="text-muted-foreground mt-2 text-sm">
        From BlakPath&apos;s tamper-evident audit trail. Most recent first.
      </p>
      {overview.history.length === 0 ? (
        <p className="mt-3 text-sm">No key events are recorded yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-border border-b">
                <th scope="col" className="py-2 pr-4 font-medium">
                  When
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Event
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Version
                </th>
                <th scope="col" className="py-2 font-medium">
                  By
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.history.map((entry) => (
                <tr key={entry.id} className="border-border border-b align-top">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {formatDateTime(entry.at)}
                  </td>
                  <td className="py-2 pr-4">
                    {entry.summary}
                    {entry.detail ? (
                      <span className="text-muted-foreground"> ({entry.detail})</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4">{entry.keyVersion ?? '—'}</td>
                  <td className="py-2">{entry.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Org settings → Encryption keys. Organisation administrators only
 * (`tenant:configure`), with a recent sign-in. Viewing is audited.
 */
export default async function EncryptionKeysPage() {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.sensitiveAction);
  } catch (error) {
    if (!(error instanceof StepUpRequiredError)) throw error;
    return (
      <Shell>
        <Alert tone="info" role="status" title="Sign in again to continue">
          Encryption key details need a sign-in from the last 10 minutes. Sign out and
          back in, then open this page again.
        </Alert>
      </Shell>
    );
  }

  let overview: KeyCustodyOverview | null;
  try {
    overview = await withRequestTenant(() => getKeyCustodyOverview());
  } catch (error) {
    if (isAuthorizationError(error) || error instanceof TenantContextError) {
      return (
        <Shell>
          <p className="text-muted-foreground">
            Only organisation administrators can view encryption keys.
          </p>
        </Shell>
      );
    }
    throw error;
  }

  if (!overview) {
    return (
      <Shell>
        <Alert tone="info" role="status" title="No organisation key yet">
          BlakPath has not registered a key for this organisation. Contact BlakPath
          support to set up a key in the custody mode you have agreed.
        </Alert>
      </Shell>
    );
  }

  return (
    <Shell>
      {overview.status !== 'active' ? (
        <Alert tone="warning" role="status" title="Records are locked">
          The key is {KEY_STATUS_LABEL[overview.status].toLowerCase()}. Nothing was read.
          Other organisations are unaffected.
        </Alert>
      ) : null}
      <KeyDetails overview={overview} />
      <CloudTrailSection overview={overview} />
      <HistorySection overview={overview} />
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <ShieldCheck className="size-4" aria-hidden="true" />
        Viewing this page and every check are recorded in the audit trail.
      </p>
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <CircleAlert className="size-4" aria-hidden="true" />
        To rotate or replace the key, contact BlakPath support. A key change is a recorded
        custody ceremony, not a setting.
      </p>
    </Shell>
  );
}
