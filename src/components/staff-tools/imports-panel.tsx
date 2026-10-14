'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { parseApplicationImportLines } from '@/domains/imports/parse-lines';
import { staffJson } from '@/components/staff-tools/request';

interface ImportResponse {
  dryRun: boolean;
  total: number;
  created: number;
  failures: { index: number; error: string }[];
}

export function ImportsPanel() {
  const [text, setText] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<readonly string[]>([]);
  const [result, setResult] = useState<ImportResponse | null>(null);

  return (
    <form
      className="grid gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        setLineErrors([]);
        setResult(null);
        const parsed = parseApplicationImportLines(text);
        if (parsed.errors.length > 0 || parsed.rows.length === 0) {
          setLineErrors(
            parsed.rows.length === 0 && parsed.errors.length === 0
              ? ['Add at least one name.']
              : parsed.errors.map((item) =>
                  item.line > 0 ? `Line ${item.line}: ${item.message}` : item.message,
                ),
          );
          return;
        }
        setBusy(true);
        try {
          const response = await staffJson<ImportResponse>(
            '/api/imports/applications',
            'POST',
            {
              rows: parsed.rows,
              dryRun,
            },
          );
          setResult(response);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'That could not be saved.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="import-lines">Applications to import</Label>
        <p id="import-lines-help" className="text-muted-foreground text-sm">
          One person per line. Add a priority after a comma: low, normal or high. Lines
          starting with # are ignored. Imported applications start as drafts. Nothing is
          decided.
        </p>
        <Textarea
          id="import-lines"
          aria-describedby="import-lines-help"
          value={text}
          rows={8}
          onChange={(event) => setText(event.target.value)}
          required
        />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={dryRun}
          onChange={(event) => setDryRun(event.target.checked)}
        />
        <span>Check only, do not create applications</span>
      </label>
      <Button type="submit" disabled={busy}>
        {busy ? 'Working…' : dryRun ? 'Check import' : 'Import applications'}
      </Button>
      {lineErrors.length > 0 ? (
        <Alert role="alert" tone="destructive" title="Import needs another look">
          <ul className="list-disc pl-5">
            {lineErrors.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {error ? (
        <Alert role="alert" tone="destructive" title="Import not completed">
          {error}
        </Alert>
      ) : null}
      {result ? (
        <Alert tone={result.failures.length > 0 ? 'warning' : 'success'}>
          {result.dryRun
            ? `Check finished. ${result.total - result.failures.length} of ${result.total} names are valid. Nothing was created.`
            : `Created ${result.created} of ${result.total} applications as drafts.`}
          {result.failures.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {result.failures.map((failure) => (
                <li key={`${failure.index}-${failure.error}`}>
                  Row {failure.index + 1}: {failure.error}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </form>
  );
}
