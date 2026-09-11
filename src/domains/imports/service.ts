import { z } from 'zod';
import { createApplication } from '@/domains/applications/service';
import { createApplicationSchema } from '@/domains/applications/schemas';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { currentScope } from '@/db/tenant-db';

/**
 * Legacy bulk import — tenant-scoped, permission-checked, audited.
 *
 * Imports land as `draft` matters through the normal `createApplication`
 * path, so every record is validated, tenant-bound, and individually audited.
 * Nothing here transitions, decides, or finalises — imported matters enter at
 * intake states only. Batches cap at 100 rows; larger migrations run as
 * repeated calls (chunked worker wiring is a follow-up). `dryRun` validates
 * every row and reports without writing.
 */

const importRowSchema = createApplicationSchema;
const importBatchSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(100),
  dryRun: z.boolean().optional(),
});

export interface ImportResult {
  dryRun: boolean;
  total: number;
  created: number;
  failures: { index: number; error: string }[];
}

export async function runApplicationImport(raw: unknown): Promise<ImportResult> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'application:create');
  const input = importBatchSchema.parse(raw);
  const scope = currentScope();
  void scope;

  const failures: ImportResult['failures'] = [];
  let created = 0;
  if (!input.dryRun) {
    for (let i = 0; i < input.rows.length; i += 1) {
      try {
        await createApplication(input.rows[i]!);
        created += 1;
      } catch (error) {
        failures.push({
          index: i,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  } else {
    // Dry run: validate only. createApplicationSchema.parse throws per row.
    input.rows.forEach((row, i) => {
      try {
        createApplicationSchema.parse(row);
      } catch (error) {
        failures.push({
          index: i,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  await recordAudit({
    action: 'import.completed',
    resourceType: 'import',
    resourceId: null,
    result: failures.length > 0 ? 'failure' : 'success',
    reason: `import ${input.dryRun ? 'dry-run' : 'commit'}: ${created}/${input.rows.length} created`,
  });

  return { dryRun: input.dryRun ?? false, total: input.rows.length, created, failures };
}
