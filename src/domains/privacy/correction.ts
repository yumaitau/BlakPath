import { and, eq } from 'drizzle-orm';
import { associatedStatements } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { isCorrectable, SUBJECT_TABLES } from './registry';
import { loadOpenRequest, markInProgress, type RightsRequestRow } from './requests';
import {
  associateStatementSchema,
  correctRecordSchema,
  type AssociateStatementInput,
  type CorrectRecordInput,
} from './schemas';
import { columnByName, columnKeys, resolveSubject, SUBJECT_TARGETS } from './subject';

/**
 * Correction (APP 13).
 *
 * A correction changes one registry-marked correctable field on one record that
 * belongs to the request's subject. When the organisation declines to correct,
 * the person may ask for a statement to be associated with the record instead
 * (APP 13.4); statements are part of every subject bundle. Audit metadata names
 * the table and field — never the old or new value.
 */

export type AssociatedStatementRow = typeof associatedStatements.$inferSelect;

/** Confirm `recordId` in `table` belongs to the request's subject. */
async function assertSubjectRecord(
  request: RightsRequestRow,
  table: string,
  recordId: string,
): Promise<void> {
  const target = SUBJECT_TARGETS[table];
  if (!target) throw new AuthorizationError('POLICY_DENIED', 'Unknown record type.');
  const scope = currentScope();
  const subject = await resolveSubject(scope, {
    clientId: request.subjectClientId,
    userId: request.subjectUserId,
  });
  const rows = await scope.db
    .select({ id: target.id })
    .from(target.table)
    .where(
      and(
        eq(target.organisationId, scope.organisationId),
        eq(target.id, recordId),
        target.match(subject),
      ),
    )
    .limit(1);
  if (rows.length === 0) throw new AuthorizationError('POLICY_DENIED');
}

/** Correct one field of one record. Requires `privacy:manage`. */
export async function correctRecord(
  requestId: string,
  rawInput: CorrectRecordInput,
): Promise<void> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  const input = correctRecordSchema.parse(rawInput);
  if (!isCorrectable(input.table, input.field)) {
    throw new AuthorizationError('POLICY_DENIED', 'That field cannot be corrected here.');
  }
  const request = await loadOpenRequest(requestId, ['correction']);
  await assertSubjectRecord(request, input.table, input.recordId);

  const target = SUBJECT_TARGETS[input.table]!;
  const key = columnKeys(target.table).get(input.field);
  const column = columnByName(target.table, input.field);
  if (!key || !column) {
    throw new Error(`Registry column ${input.table}.${input.field} is unknown.`);
  }
  const isJson = column.dataType === 'json';
  if (isJson !== (typeof input.value === 'object' && input.value !== null)) {
    throw new AuthorizationError('POLICY_DENIED', 'The value does not fit that field.');
  }
  if (input.value === null || input.value === '') {
    if (column.notNull) {
      throw new AuthorizationError('POLICY_DENIED', 'That field cannot be emptied.');
    }
  }
  const value = input.value === '' ? null : input.value;

  const scope = currentScope();
  await scope.db
    .update(target.table)
    .set({ [key]: value })
    .where(
      and(eq(target.organisationId, scope.organisationId), eq(target.id, input.recordId)),
    );
  await markInProgress(request);

  await recordAudit({
    action: 'privacy.record_corrected',
    resourceType: 'rights_request',
    resourceId: requestId,
    result: 'success',
    after: {
      data: { table: input.table, recordId: input.recordId, field: input.field },
      allow: ['table', 'recordId', 'field'],
    },
  });
}

/** Associate the person's statement with a record. Requires `privacy:manage`. */
export async function associateStatement(
  requestId: string,
  rawInput: AssociateStatementInput,
): Promise<AssociatedStatementRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  const input = associateStatementSchema.parse(rawInput);
  if (!SUBJECT_TABLES.includes(input.table)) {
    throw new AuthorizationError('POLICY_DENIED', 'Unknown record type.');
  }
  const request = await loadOpenRequest(requestId, ['correction', 'complaint']);
  await assertSubjectRecord(request, input.table, input.recordId);

  const scope = currentScope();
  const inserted = await scope.db
    .insert(associatedStatements)
    .values(
      scope.insertValues({
        requestId,
        resourceType: input.table,
        resourceId: input.recordId,
        field: input.field ?? null,
        statement: input.statement,
        recordedByUserId: ctx.userId,
      }),
    )
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('Expected associated statement to be returned.');
  await markInProgress(request);

  await recordAudit({
    action: 'privacy.statement_associated',
    resourceType: 'associated_statement',
    resourceId: row.id,
    result: 'success',
    after: {
      data: { requestId, table: input.table, recordId: input.recordId },
      allow: ['requestId', 'table', 'recordId'],
    },
  });
  return row;
}

/** Statements attached to one record, for showing alongside it. */
export async function listStatementsFor(
  table: string,
  recordId: string,
): Promise<AssociatedStatementRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  const scope = currentScope();
  return scope.db
    .select()
    .from(associatedStatements)
    .where(
      scope.where(
        associatedStatements.organisationId,
        eq(associatedStatements.resourceType, table),
        eq(associatedStatements.resourceId, recordId),
      ),
    );
}
