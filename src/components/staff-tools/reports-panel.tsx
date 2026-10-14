'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StepUpDialog, useStepUp } from '@/components/auth/step-up-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { staffDownload, staffJson } from '@/components/staff-tools/request';
import {
  formatStaffDate,
  humanStatus,
  nativeSelectClass,
} from '@/components/staff-tools/staff-tool-frame';

export interface ReportExportItem {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  rowCount: number | null;
}

const REPORT_OPTIONS = [
  { value: 'applications', label: 'Applications' },
  { value: 'decisions', label: 'Decisions' },
  { value: 'certificates', label: 'Certificates' },
] as const;

export function ReportsPanel({
  items,
  canExport,
}: {
  items: readonly ReportExportItem[];
  canExport: boolean;
}) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [type, setType] =
    useState<(typeof REPORT_OPTIONS)[number]['value']>('applications');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="grid gap-8">
      <StepUpDialog open={stepUp.open} onFinish={stepUp.finish} />
      {canExport ? (
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            setMessage(null);
            try {
              await staffJson('/api/reports/exports', 'POST', { type }, () =>
                stepUp.request(),
              );
              setMessage(
                'Export requested. It will appear in the list when the file is ready.',
              );
              router.refresh();
            } catch (caught) {
              setError(
                caught instanceof Error ? caught.message : 'That could not be saved.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="report-type">Report</Label>
            <select
              id="report-type"
              className={nativeSelectClass}
              value={type}
              onChange={(event) =>
                setType(event.target.value as (typeof REPORT_OPTIONS)[number]['value'])
              }
            >
              {REPORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-sm">
              Requesting an export is recorded in the audit trail.
            </p>
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Requesting…' : 'Request export'}
          </Button>
        </form>
      ) : (
        <p className="text-sm">
          You can view exports. Requesting a new file needs the export permission.
        </p>
      )}

      {error ? (
        <Alert role="alert" tone="destructive" title="Export not completed">
          {error}
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <section aria-labelledby="export-list-heading">
        <h2 id="export-list-heading" className="text-lg font-semibold">
          Requested exports
        </h2>
        {items.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">
            No exports have been requested.
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
                    {humanStatus(item.type)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {humanStatus(item.status)} · {formatStaffDate(item.createdAt)}
                    {item.rowCount !== null ? ` · ${item.rowCount} rows` : ''}
                  </span>
                </span>
                {item.status === 'ready' && canExport ? (
                  <button
                    type="button"
                    className="text-primary text-left text-sm font-semibold underline-offset-4 hover:underline disabled:opacity-60"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError(null);
                      setMessage(null);
                      try {
                        await staffDownload(
                          `/api/reports/exports/${item.id}/download`,
                          () => stepUp.request(),
                        );
                      } catch (caught) {
                        setError(
                          caught instanceof Error
                            ? caught.message
                            : 'That file could not be downloaded.',
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Download {humanStatus(item.type)} CSV
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
