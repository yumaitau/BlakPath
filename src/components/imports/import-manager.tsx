'use client';

import { CheckCircle2, Clock3, Loader2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

/**
 * Legacy CSV import (client).
 *
 * Flow: choose a CSV → "Check file" runs a dry run (nothing is written) and
 * shows the validation report → "Start import" stages the same file and the
 * worker imports it in the background; progress is polled until it settles.
 * Re-running a file is safe: rows already imported are skipped.
 */

export interface ImportIssueView {
  row: number;
  externalReference?: string;
  error: string;
}

export interface ImportJobView {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  fileName: string | null;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  skippedCount: number;
  failedCount: number;
  issues: ImportIssueView[];
  error: string | null;
  createdAt: string;
}

interface ValidationReport {
  total: number;
  importable: number;
  duplicates: number;
  invalid: number;
  withOutcome: number;
  withCertificate: number;
  issues: ImportIssueView[];
  missingPermissions: string[];
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const POLL_MS = 2_000;

const statusBadge = {
  pending: { tone: 'neutral' as const, icon: Clock3, label: 'Queued' },
  processing: { tone: 'info' as const, icon: Loader2, label: 'Importing' },
  completed: { tone: 'success' as const, icon: CheckCircle2, label: 'Completed' },
  failed: { tone: 'destructive' as const, icon: XCircle, label: 'Stopped' },
};

function IssueTable({ issues }: { issues: ImportIssueView[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="border-border mt-4 max-h-80 overflow-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Rows that need attention</caption>
        <thead className="bg-surface-muted sticky top-0">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Row
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Legacy reference
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Problem
            </th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={`${issue.row}-${issue.error}`} className="border-border border-t">
              <td className="px-3 py-2 tabular-nums">{issue.row}</td>
              <td className="px-3 py-2">{issue.externalReference ?? '—'}</td>
              <td className="px-3 py-2">{issue.error}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobProgress({ job }: { job: ImportJobView }) {
  const percent =
    job.totalRows > 0 ? Math.floor((job.processedRows / job.totalRows) * 100) : 0;
  const badge = statusBadge[job.status];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{job.fileName ?? 'Import'}</span>
        <Badge tone={badge.tone} icon={badge.icon}>
          {badge.label}
        </Badge>
      </div>
      <progress
        className="h-2 w-full"
        max={job.totalRows}
        value={job.processedRows}
        aria-label={`${percent}% of rows processed`}
      />
      <p className="text-muted-foreground text-sm">
        {job.processedRows} of {job.totalRows} rows processed · {job.createdCount}{' '}
        imported · {job.skippedCount} already imported · {job.failedCount} with problems
      </p>
      {job.error ? <Alert tone="destructive">{job.error}</Alert> : null}
    </div>
  );
}

export function ImportManager({
  initialJobs,
  canImportOutcomes,
  canImportCertificates,
}: {
  initialJobs: ImportJobView[];
  canImportOutcomes: boolean;
  canImportCertificates: boolean;
}) {
  const router = useRouter();
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [fileProblems, setFileProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'start' | null>(null);
  const [activeJob, setActiveJob] = useState<ImportJobView | null>(
    initialJobs.find((j) => j.status === 'pending' || j.status === 'processing') ?? null,
  );
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!activeJob || activeJob.status === 'completed' || activeJob.status === 'failed') {
      return;
    }
    pollTimer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/imports/${activeJob.id}`, {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const next = (await response.json()) as ImportJobView;
        setActiveJob(next);
        if (next.status === 'completed' || next.status === 'failed') router.refresh();
      } catch {
        // Transient network error: the next render schedules another poll.
        setActiveJob((job) => (job ? { ...job } : job));
      }
    }, POLL_MS);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [activeJob, router]);

  async function chooseFile(event: React.ChangeEvent<HTMLInputElement>) {
    setReport(null);
    setFileProblems([]);
    setError(null);
    setCsv(null);
    const file = event.target.files?.[0];
    if (!file) {
      setFileName(null);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is larger than 5 MB. Split it into smaller files.');
      return;
    }
    setFileName(file.name);
    setCsv(await file.text());
  }

  async function send(dryRun: boolean): Promise<Response | null> {
    if (!csv) return null;
    return fetch('/api/imports/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv, fileName: fileName ?? undefined, dryRun }),
    });
  }

  async function handleFileError(response: Response): Promise<boolean> {
    if (response.status !== 400) return false;
    const data = (await response.json().catch(() => ({}))) as { problems?: string[] };
    setFileProblems(data.problems ?? ['The file could not be read.']);
    return true;
  }

  async function check() {
    setBusy('check');
    setError(null);
    setFileProblems([]);
    setReport(null);
    try {
      const response = await send(true);
      if (!response) return;
      if (await handleFileError(response)) return;
      if (!response.ok) {
        setError('The file could not be checked. Check your permissions and try again.');
        return;
      }
      setReport((await response.json()) as ValidationReport);
    } catch {
      setError('We could not reach the service. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setBusy('start');
    setError(null);
    try {
      const response = await send(false);
      if (!response) return;
      if (await handleFileError(response)) return;
      if (!response.ok) {
        setError(
          'The import could not be started. Check your permissions and try again.',
        );
        return;
      }
      const job = (await response.json()) as ImportJobView;
      setActiveJob(job);
      setReport(null);
      router.refresh();
    } catch {
      setError('We could not reach the service. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  const canStart =
    report !== null &&
    report.importable > 0 &&
    report.missingPermissions.length === 0 &&
    busy === null &&
    !(activeJob && (activeJob.status === 'pending' || activeJob.status === 'processing'));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Import a CSV file</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="import-file">CSV file (up to 5 MB, 10,000 rows)</Label>
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => void chooseFile(event)}
              className="text-sm"
            />
          </div>
          {!canImportOutcomes || !canImportCertificates ? (
            <p className="text-muted-foreground text-sm">
              {!canImportOutcomes
                ? 'Files with recorded outcomes need someone who can also finalise decisions. '
                : ''}
              {!canImportCertificates
                ? 'Files with legacy certificates need someone who can also sign certificates.'
                : ''}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={!csv || busy !== null}
              onClick={() => void check()}
            >
              {busy === 'check' ? 'Checking…' : 'Check file (dry run)'}
            </Button>
            <Button type="button" disabled={!canStart} onClick={() => void start()}>
              {busy === 'start' ? 'Starting…' : 'Start import'}
            </Button>
          </div>
          {error ? (
            <Alert tone="destructive" role="alert">
              {error}
            </Alert>
          ) : null}
          {fileProblems.length > 0 ? (
            <Alert tone="destructive" role="alert" title="This file can’t be imported">
              <ul className="list-disc pl-5">
                {fileProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {report ? (
            <section aria-labelledby="dry-run-heading">
              <h3 id="dry-run-heading" className="font-semibold">
                Dry-run report — nothing has been imported yet
              </h3>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Rows in file</dt>
                <dd className="tabular-nums">{report.total}</dd>
                <dt className="text-muted-foreground">Ready to import</dt>
                <dd className="tabular-nums">{report.importable}</dd>
                <dt className="text-muted-foreground">
                  Already imported (will be skipped)
                </dt>
                <dd className="tabular-nums">{report.duplicates}</dd>
                <dt className="text-muted-foreground">Rows with problems</dt>
                <dd className="tabular-nums">{report.invalid}</dd>
                <dt className="text-muted-foreground">With a recorded outcome</dt>
                <dd className="tabular-nums">{report.withOutcome}</dd>
                <dt className="text-muted-foreground">With a legacy certificate</dt>
                <dd className="tabular-nums">{report.withCertificate}</dd>
              </dl>
              {report.missingPermissions.length > 0 ? (
                <Alert tone="warning" className="mt-3">
                  You can’t import this file: it needs{' '}
                  {report.missingPermissions.join(', ')}.
                </Alert>
              ) : null}
              {report.invalid > 0 ? (
                <p className="text-muted-foreground mt-3 text-sm">
                  Rows with problems are left out of the import. Fix them and re-run the
                  same file — rows already imported are skipped.
                </p>
              ) : null}
              <IssueTable issues={report.issues} />
            </section>
          ) : null}
        </CardContent>
      </Card>

      {activeJob ? (
        <Card>
          <CardHeader>
            <CardTitle>Current import</CardTitle>
          </CardHeader>
          <CardContent>
            <div aria-live="polite">
              <JobProgress job={activeJob} />
            </div>
            <IssueTable issues={activeJob.issues} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Recent imports</CardTitle>
        </CardHeader>
        <CardContent>
          {initialJobs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No imports yet.</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {initialJobs.map((job) => (
                <li key={job.id} className="border-border rounded-lg border p-4">
                  <JobProgress job={job} />
                  <p className="text-muted-foreground mt-1 text-xs">
                    Started {new Date(job.createdAt).toLocaleString('en-AU')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
