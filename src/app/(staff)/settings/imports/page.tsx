import type { Metadata } from 'next';

import { ImportManager, type ImportJobView } from '@/components/imports/import-manager';
import { IMPORT_COLUMNS, listImports } from '@/domains/imports';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { hasPermission, subjectFromContext } from '@/lib/permissions/check';

/**
 * Legacy data import (RSC). Lists recent imports and hosts the CSV upload with
 * its dry-run report. Only intake staff who can see every matter may import;
 * outcomes and certificates additionally need finalise / sign permissions.
 */
export const metadata: Metadata = {
  title: 'Legacy import — BlakPath',
};

export const dynamic = 'force-dynamic';

export default async function ImportsSettingsPage() {
  let data: {
    jobs: ImportJobView[];
    canImportOutcomes: boolean;
    canImportCertificates: boolean;
  } | null = null;
  try {
    data = await withRequestTenant(async (ctx) => {
      const subject = subjectFromContext(ctx);
      const jobs = await listImports();
      return {
        jobs: jobs.map((job) => ({
          id: job.id,
          status: job.status,
          fileName: job.fileName,
          totalRows: job.totalRows,
          processedRows: job.processedRows,
          createdCount: job.createdCount,
          skippedCount: job.skippedCount,
          failedCount: job.failedCount,
          issues: job.issues,
          error: job.error,
          createdAt: job.createdAt.toISOString(),
        })),
        canImportOutcomes: hasPermission(subject, 'decision:finalise'),
        canImportCertificates: hasPermission(subject, 'certificate:sign'),
      };
    });
  } catch {
    data = null;
  }

  return (
    <section
      aria-labelledby="imports-heading"
      className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6"
    >
      <h1 id="imports-heading" className="text-2xl font-semibold tracking-tight">
        Legacy import
      </h1>
      <p className="text-muted-foreground mt-2">
        Bring matters, their recorded outcomes and certificates issued before BlakPath
        across from your previous system. Imported outcomes and certificates are kept as
        records made before BlakPath — the import never decides anything.
      </p>
      {data ? (
        <>
          <details className="border-border mt-6 rounded-lg border p-4 text-sm">
            <summary className="cursor-pointer font-medium">File format</summary>
            <p className="text-muted-foreground mt-2">
              One row per matter. Required: <code>external_reference</code> (the id in
              your previous system — re-running a file skips rows already imported) and{' '}
              <code>applicant_name</code>. Dates are YYYY-MM-DD. Add{' '}
              <code>intake.&lt;field&gt;</code> columns for intake details. A recorded
              outcome needs status <code>decided</code> or <code>closed</code>,{' '}
              <code>decided_on</code> and <code>outcome_recorded_by</code>; a legacy
              certificate needs a <code>confirmed</code> outcome and{' '}
              <code>certificate_issued_on</code>.
            </p>
            <p className="mt-2 font-mono text-xs break-all">{IMPORT_COLUMNS.join(',')}</p>
          </details>
          <div className="mt-6">
            <ImportManager
              initialJobs={data.jobs}
              canImportOutcomes={data.canImportOutcomes}
              canImportCertificates={data.canImportCertificates}
            />
          </div>
        </>
      ) : (
        <p className="text-muted-foreground mt-6">
          Only intake staff who can see every application can import legacy records.
        </p>
      )}
    </section>
  );
}
