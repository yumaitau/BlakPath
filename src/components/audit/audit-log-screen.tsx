import { Ban, Check, CircleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AUDIT_EXPORT_MAX_ROWS,
  toAuditQueryString,
  type AuditLogEntry,
  type AuditLogPage,
} from '@/domains/audit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sydneyTime = new Intl.DateTimeFormat('en-AU', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Australia/Sydney',
});

export interface AuditLogFormValues {
  readonly caseId: string;
  readonly userId: string;
  readonly action: string;
  readonly from: string;
  readonly to: string;
  readonly breakGlass: boolean;
  readonly denials: boolean;
}

/** Staff audit trail: filters, one page of events, and a formula-safe export. */
export function AuditLogScreen({
  values,
  page,
  invalid,
}: {
  values: AuditLogFormValues;
  page?: AuditLogPage;
  invalid?: boolean;
}) {
  const previous =
    page && page.offset > 0
      ? toAuditQueryString(
          { ...page.filters, offset: Math.max(0, page.offset - page.limit) },
          { includePaging: true },
        )
      : null;
  const next =
    page && page.offset + page.items.length < page.total
      ? toAuditQueryString(
          { ...page.filters, offset: page.offset + page.limit },
          { includePaging: true },
        )
      : null;
  const fromRow = page && page.total > 0 ? page.offset + 1 : 0;
  const toRow = page ? page.offset + page.items.length : 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit trail</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Who viewed or changed records in this organisation. Opening this page is
            recorded. The trail does not decide Aboriginality.
          </p>
        </div>
        <a
          href="/audit/review"
          className="text-primary text-sm font-semibold underline underline-offset-4"
        >
          Monthly review checklist
        </a>
      </div>

      <form
        method="get"
        action="/audit"
        className="mt-6"
        aria-label="Filter the audit trail"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="audit-case">Case</Label>
            <Input
              id="audit-case"
              name="case"
              defaultValue={values.caseId}
              placeholder="Application id"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-user">User</Label>
            <Input
              id="audit-user"
              name="user"
              defaultValue={values.userId}
              placeholder="Person id"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-action">Action</Label>
            <Input
              id="audit-action"
              name="action"
              defaultValue={values.action}
              placeholder="application.viewed"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-from">From</Label>
            <Input id="audit-from" name="from" type="date" defaultValue={values.from} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-to">To</Label>
            <Input id="audit-to" name="to" type="date" defaultValue={values.to} />
          </div>
          <fieldset className="flex flex-col justify-end gap-2">
            <legend className="sr-only">Event kinds</legend>
            <label
              className="flex items-center gap-2 text-sm font-medium"
              htmlFor="audit-denials"
            >
              <input
                id="audit-denials"
                name="denials"
                type="checkbox"
                value="1"
                defaultChecked={values.denials}
                className="border-input size-4 rounded"
              />
              Denials only
            </label>
            <label
              className="flex items-center gap-2 text-sm font-medium"
              htmlFor="audit-break-glass"
            >
              <input
                id="audit-break-glass"
                name="breakGlass"
                type="checkbox"
                value="1"
                defaultChecked={values.breakGlass}
                className="border-input size-4 rounded"
              />
              Break-glass only
            </label>
          </fieldset>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" size="sm">
            Apply filters
          </Button>
          <Button
            type="submit"
            formAction="/api/audit/events/export"
            variant="secondary"
            size="sm"
          >
            Export CSV
          </Button>
        </div>
        <p className="text-muted-foreground mt-2 text-sm">
          CSV cells that start with a formula character are prefixed so a spreadsheet does
          not run them. An export keeps the newest{' '}
          {AUDIT_EXPORT_MAX_ROWS.toLocaleString('en-AU')} matching rows.
        </p>
      </form>

      {invalid ? (
        <p className="text-destructive mt-6 text-sm" role="alert">
          Those filters are not valid. Check the case id, user id, action and dates.
        </p>
      ) : null}

      {page ? (
        <div className="mt-6">
          <p className="text-muted-foreground text-sm">
            {page.total === 0
              ? 'No audit events match these filters.'
              : `Showing ${fromRow.toLocaleString('en-AU')}–${toRow.toLocaleString('en-AU')} of ${page.total.toLocaleString('en-AU')}.`}
          </p>
          <div className="border-border mt-3 overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <caption className="sr-only">Audit events for this organisation</caption>
              <thead className="bg-surface-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    When (Sydney)
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Who
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Action
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Record
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Result
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Reason
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((event) => (
                  <AuditRow key={event.id} event={event} />
                ))}
              </tbody>
            </table>
          </div>
          <nav className="mt-4 flex gap-4 text-sm font-semibold" aria-label="Audit pages">
            {previous !== null ? (
              <a href={previous === '' ? '/audit' : `/audit?${previous}`}>Previous</a>
            ) : (
              <span className="text-muted-foreground">Previous</span>
            )}
            {next !== null ? (
              <a href={`/audit?${next}`}>Next</a>
            ) : (
              <span className="text-muted-foreground">Next</span>
            )}
          </nav>
        </div>
      ) : null}
    </div>
  );
}

function AuditRow({ event }: { event: AuditLogEntry }) {
  const when = sydneyTime.format(new Date(event.timestamp));
  const who = event.actorName ?? (event.actorUserId ? 'Unknown person' : 'System');
  const applicationLink =
    event.resourceType === 'application' &&
    event.resourceId !== null &&
    UUID.test(event.resourceId);
  return (
    <tr className="border-border border-t">
      <td className="px-3 py-2 align-top whitespace-nowrap">
        <time dateTime={event.timestamp} title={event.timestamp}>
          {when}
        </time>
      </td>
      <td className="px-3 py-2 align-top">
        <div>{who}</div>
        {event.actingRole ? (
          <div className="text-muted-foreground text-xs">{event.actingRole}</div>
        ) : null}
        {event.actorUserId ? (
          <div className="text-muted-foreground font-mono text-xs">
            {event.actorUserId}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 align-top font-mono text-xs">{event.action}</td>
      <td className="px-3 py-2 align-top">
        <div>{event.resourceType}</div>
        {event.resourceId ? (
          applicationLink ? (
            <a
              href={`/applications/${event.resourceId}`}
              className="text-primary font-mono text-xs underline underline-offset-4"
            >
              {event.resourceId}
            </a>
          ) : (
            <div className="text-muted-foreground font-mono text-xs">
              {event.resourceId}
            </div>
          )
        ) : null}
      </td>
      <td className="px-3 py-2 align-top">
        <ResultBadge result={event.result} />
      </td>
      <td className="px-3 py-2 align-top">{event.reason ?? ''}</td>
    </tr>
  );
}

function ResultBadge({ result }: { result: AuditLogEntry['result'] }) {
  if (result === 'success') {
    return (
      <Badge tone="success" icon={Check}>
        Success
      </Badge>
    );
  }
  if (result === 'denied') {
    return (
      <Badge tone="destructive" icon={Ban}>
        Denied
      </Badge>
    );
  }
  return (
    <Badge tone="warning" icon={CircleAlert}>
      Failure
    </Badge>
  );
}
