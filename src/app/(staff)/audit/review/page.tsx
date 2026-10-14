import type { Metadata } from 'next';
import { MonthlyReviewForm } from '@/components/audit/monthly-review-form';
import {
  AUDIT_MONTHLY_REVIEW_CHECKS,
  viewAuditChecklist,
  type AuditLogEntry,
} from '@/domains/audit';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { AuthorizationError } from '@/lib/permissions/errors';

export const metadata: Metadata = {
  title: 'Monthly audit review — BlakPath',
};

type Search = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ?? '';
}

function currentPeriod(now = new Date()): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

function monthBounds(period: string): { from: string; to: string } {
  const [yearRaw, monthRaw] = period.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

export default async function AuditReviewPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const search = await searchParams;
  const period = currentPeriod();
  const bounds = monthBounds(period);
  const recorded = first(search.recorded) === '1';
  const error = first(search.error);

  let reviews: readonly AuditLogEntry[] = [];
  let denied = false;
  let unavailable = false;
  try {
    const loaded = await withRequestTenant(() => viewAuditChecklist());
    reviews = loaded.reviews;
  } catch (caught) {
    if (caught instanceof AuthorizationError) {
      denied = true;
    } else {
      unavailable = true;
    }
  }

  if (denied) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        You do not have permission to view the audit trail.
      </p>
    );
  }
  if (unavailable) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        Sign in and select an organisation to open the monthly review.
      </p>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <p className="text-sm font-semibold">
        <a href="/audit" className="text-primary underline underline-offset-4">
          Audit trail
        </a>
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Monthly audit review</h1>
      <p className="text-muted-foreground mt-2">
        Work through this once each calendar month. It checks that human acts were
        recorded. It does not score, rank, approve or reject anyone. The same checklist is
        in <span className="font-mono">docs/audit-monthly-review.md</span>.
      </p>

      {recorded ? (
        <p className="mt-4 text-sm font-medium" role="status">
          Review recorded on the audit trail.
        </p>
      ) : null}
      {error === 'forbidden' ? (
        <p className="text-destructive mt-4 text-sm" role="alert">
          You do not have permission to record this review.
        </p>
      ) : null}
      {error === 'invalid' ? (
        <p className="text-destructive mt-4 text-sm" role="alert">
          Enter a month as YYYY-MM. Notes must be 500 characters or fewer.
        </p>
      ) : null}

      <ol className="mt-6 space-y-4">
        {AUDIT_MONTHLY_REVIEW_CHECKS.map((check, index) => (
          <li key={check.id} className="border-border bg-surface rounded-lg border p-4">
            <h2 className="font-semibold">
              {index + 1}. {check.title}
            </h2>
            <p className="mt-1 text-sm">{check.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-sm font-semibold">
        <a
          href={`/audit?denials=1&from=${bounds.from}&to=${bounds.to}`}
          className="text-primary underline underline-offset-4"
        >
          This month’s denials
        </a>
        <a
          href={`/audit?breakGlass=1&from=${bounds.from}&to=${bounds.to}`}
          className="text-primary underline underline-offset-4"
        >
          This month’s break-glass
        </a>
        <a
          href={`/audit?action=audit.exported&from=${bounds.from}&to=${bounds.to}`}
          className="text-primary underline underline-offset-4"
        >
          Audit exports
        </a>
        <a
          href={`/audit?action=export.downloaded&from=${bounds.from}&to=${bounds.to}`}
          className="text-primary underline underline-offset-4"
        >
          Report exports
        </a>
      </div>

      <MonthlyReviewForm defaultPeriod={period} />

      <h2 className="mt-10 text-lg font-semibold">Recorded reviews</h2>
      {reviews.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">
          No monthly review recorded yet.
        </p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {reviews.map((review) => (
            <li key={review.id} className="border-border rounded-md border px-3 py-2">
              <span className="font-semibold">{review.resourceId ?? 'Review'}</span>
              <span className="text-muted-foreground">
                {' '}
                · {review.actorName ?? 'Unknown person'} · {review.timestamp}
              </span>
              {review.reason ? <p className="mt-1">{review.reason}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
