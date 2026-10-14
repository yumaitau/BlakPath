import { and, count, desc, eq, gte, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvents, users } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { toCsv, type CsvCell } from '@/domains/reporting/csv';
import { requireTenantContext } from '@/lib/tenancy/context';
import { hasPermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import type { AuditAction, AuditResult } from './events';
import { recordAudit } from './service';

/**
 * Tenant audit-log viewer.
 *
 * Reads are scoped with `currentScope()` — the organisation id always comes
 * from the verified TenantContext, never from the query string. Opening the
 * log, exporting it, and recording the monthly review are themselves audited.
 * Nothing here scores, ranks or decides Aboriginality.
 */

export const AUDIT_LOG_PAGE_DEFAULT = 50;
export const AUDIT_LOG_PAGE_MAX = 100;
export const AUDIT_EXPORT_MAX_ROWS = 5000;

/**
 * LIKE pattern for break-glass actions. The underscore is escaped so it is
 * literal; PostgreSQL's default LIKE escape is a backslash.
 */
export const BREAK_GLASS_ACTION_LIKE = 'break\\_glass.%';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const ACTION_PATTERN = /^[a-z0-9_.:-]{1,80}$/;

export const AUDIT_CSV_HEADERS = [
  'timestamp',
  'actorUserId',
  'actorName',
  'actingRole',
  'action',
  'resourceType',
  'resourceId',
  'result',
  'reason',
  'ipAddress',
  'correlationId',
  'beforeMeta',
  'afterMeta',
] as const;

const VIEW_META_ALLOW = [
  'surface',
  'caseId',
  'actorUserId',
  'action',
  'from',
  'to',
  'breakGlass',
  'denials',
  'rowCount',
  'truncated',
] as const;

/**
 * Monthly review steps. The same sentences are copied into
 * `docs/audit-monthly-review.md` — the unit test fails if they drift.
 * Each step is a human check. None of them decide identity.
 */
export const AUDIT_MONTHLY_REVIEW_CHECKS = [
  {
    id: 'denials',
    title: 'Permission denials',
    body: 'Filter the month to denials. Each row is a recorded refusal. Follow up anything unexplained with the person involved. The log does not decide whether someone is Aboriginal.',
  },
  {
    id: 'break-glass',
    title: 'Break-glass',
    body: 'Filter break-glass events. Every activation needs a human review once the access window ends. This screen does not approve or close break-glass by itself.',
  },
  {
    id: 'exports',
    title: 'Exports',
    body: 'Filter the actions export.downloaded and audit.exported. Confirm each bulk take of records was expected.',
  },
  {
    id: 'cases',
    title: 'Case sample',
    body: 'Pick cases the organisation worked on and filter by case id. Check that views and changes match the file. Outcomes stay human acts.',
  },
  {
    id: 'administrators',
    title: 'Administrators',
    body: 'Filter by each organisation administrator. Confirm the actions match their role.',
  },
  {
    id: 'integrity',
    title: 'Chain integrity',
    body: 'Look for audit.chain_verified or audit.divergence_detected in the month. A divergence is an incident. Do not edit audit rows.',
  },
  {
    id: 'record',
    title: 'Record the review',
    body: 'Record who completed this month’s checklist and what they will follow up. That acknowledgement is itself an audit event.',
  },
  {
    id: 'operators',
    title: 'Operator access is separate',
    body: 'AWS, database and cluster access is not in this tenant log. Operators review that access quarterly under the privileged-access process. This checklist does not replace it.',
  },
] as const;

export interface AuditLogFilters {
  readonly caseId?: string;
  readonly actorUserId?: string;
  readonly action?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly fromInput?: string;
  readonly toInput?: string;
  readonly breakGlass: boolean;
  readonly denials: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface AuditLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly actingRole: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly result: AuditResult;
  readonly reason: string | null;
}

export interface AuditLogPage {
  readonly items: readonly AuditLogEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly filters: AuditLogFilters;
}

export interface AuditLogExport {
  readonly filename: string;
  readonly csv: string;
  readonly truncated: boolean;
  readonly rowCount: number;
}

interface AuditLogRow extends AuditLogEntry {
  readonly ipAddress: string | null;
  readonly correlationId: string | null;
  readonly beforeMeta: unknown;
  readonly afterMeta: unknown;
}

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function blankToUndefined(value: unknown): string | undefined {
  const raw = firstValue(value);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

const optionalUuid = z.preprocess(blankToUndefined, z.uuid().optional());

const optionalAction = z.preprocess(
  blankToUndefined,
  z.string().regex(ACTION_PATTERN).optional(),
);

const optionalDateInput = z.preprocess(blankToUndefined, z.string().max(40).optional());

const flag = z.preprocess((value) => {
  const raw = firstValue(value);
  return raw === '1' || raw === 'true' || raw === 'on' || raw === true;
}, z.boolean());

const pageLimit = z.preprocess((value) => {
  const raw = blankToUndefined(value);
  return raw === undefined ? AUDIT_LOG_PAGE_DEFAULT : raw;
}, z.coerce.number().int().min(1).max(AUDIT_LOG_PAGE_MAX));

const pageOffset = z.preprocess((value) => {
  const raw = blankToUndefined(value);
  return raw === undefined ? 0 : raw;
}, z.coerce.number().int().min(0).max(10_000));

function endOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

function parseBound(raw: string | undefined, bound: 'from' | 'to'): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  if (bound === 'to' && DATE_ONLY.test(raw)) return endOfUtcDay(date);
  return date;
}

export const auditLogQuerySchema = z
  .object({
    case: optionalUuid,
    caseId: optionalUuid,
    user: optionalUuid,
    actorUserId: optionalUuid,
    action: optionalAction,
    from: optionalDateInput,
    to: optionalDateInput,
    breakGlass: flag,
    denials: flag,
    limit: pageLimit,
    offset: pageOffset,
  })
  .superRefine((value, ctx) => {
    if (value.case && value.caseId && value.case !== value.caseId) {
      ctx.addIssue({ code: 'custom', path: ['case'], message: 'Case filters disagree' });
    }
    if (value.user && value.actorUserId && value.user !== value.actorUserId) {
      ctx.addIssue({ code: 'custom', path: ['user'], message: 'User filters disagree' });
    }
    if (value.from && parseBound(value.from, 'from') === undefined) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'Invalid date' });
    }
    if (value.to && parseBound(value.to, 'to') === undefined) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Invalid date' });
    }
    const from = parseBound(value.from, 'from');
    const to = parseBound(value.to, 'to');
    if (from && to && from.getTime() > to.getTime()) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'End is before start' });
    }
  })
  .transform((value): AuditLogFilters => {
    const from = parseBound(value.from, 'from');
    const to = parseBound(value.to, 'to');
    const caseId = value.caseId ?? value.case;
    const actorUserId = value.actorUserId ?? value.user;
    return {
      breakGlass: value.breakGlass,
      denials: value.denials,
      limit: value.limit,
      offset: value.offset,
      ...(caseId !== undefined ? { caseId } : {}),
      ...(actorUserId !== undefined ? { actorUserId } : {}),
      ...(value.action !== undefined ? { action: value.action } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(value.from !== undefined ? { fromInput: value.from } : {}),
      ...(value.to !== undefined ? { toInput: value.to } : {}),
    };
  });

export const recordMonthlyReviewSchema = z.object({
  period: z.string().regex(PERIOD),
  notes: z.preprocess((value) => {
    const raw = blankToUndefined(value);
    return raw;
  }, z.string().trim().max(500).optional()),
});

function metaCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Serialise audit rows to a UTF-8 CSV with a BOM. Formula neutralisation and
 * RFC 4180 quoting come from the shared `toCsv` helper (GHSA-jffr-f883-3x9f).
 */
export function auditEventsToCsv(rows: readonly AuditLogRow[]): string {
  const body: CsvCell[][] = rows.map((row) => [
    row.timestamp,
    row.actorUserId ?? '',
    row.actorName ?? '',
    row.actingRole ?? '',
    row.action,
    row.resourceType,
    row.resourceId ?? '',
    row.result,
    row.reason ?? '',
    row.ipAddress ?? '',
    row.correlationId ?? '',
    metaCell(row.beforeMeta),
    metaCell(row.afterMeta),
  ]);
  return `\uFEFF${toCsv(AUDIT_CSV_HEADERS, body)}`;
}

/**
 * WHERE clause for a tenant audit query. `organisationId` is the only tenant
 * predicate and is always applied, even when every filter is empty.
 */
export function tenantAuditWhere(organisationId: string, filters: AuditLogFilters): SQL {
  const parts: SQL[] = [eq(auditEvents.organisationId, organisationId)];
  if (filters.caseId) {
    const caseId = filters.caseId;
    const caseMatch = or(
      eq(auditEvents.resourceId, caseId),
      sql`${auditEvents.afterMeta}->>'applicationId' = ${caseId}`,
      sql`${auditEvents.beforeMeta}->>'applicationId' = ${caseId}`,
    );
    if (caseMatch) parts.push(caseMatch);
  }
  if (filters.actorUserId) {
    parts.push(eq(auditEvents.actorUserId, filters.actorUserId));
  }
  if (filters.action) {
    parts.push(eq(auditEvents.action, filters.action));
  }
  if (filters.from) parts.push(gte(auditEvents.timestamp, filters.from));
  if (filters.to) parts.push(lte(auditEvents.timestamp, filters.to));
  if (filters.breakGlass) {
    const breakGlass = or(
      eq(auditEvents.resourceType, 'break_glass_request'),
      like(auditEvents.action, BREAK_GLASS_ACTION_LIKE),
    );
    if (breakGlass) parts.push(breakGlass);
  }
  if (filters.denials) parts.push(eq(auditEvents.result, 'denied'));
  return and(...parts) as SQL;
}

export function toAuditQueryString(
  filters: Pick<
    AuditLogFilters,
    | 'caseId'
    | 'actorUserId'
    | 'action'
    | 'fromInput'
    | 'toInput'
    | 'breakGlass'
    | 'denials'
    | 'limit'
    | 'offset'
  >,
  options?: { readonly includePaging?: boolean },
): string {
  const params = new URLSearchParams();
  if (filters.caseId) params.set('case', filters.caseId);
  if (filters.actorUserId) params.set('user', filters.actorUserId);
  if (filters.action) params.set('action', filters.action);
  if (filters.fromInput) params.set('from', filters.fromInput);
  if (filters.toInput) params.set('to', filters.toInput);
  if (filters.breakGlass) params.set('breakGlass', '1');
  if (filters.denials) params.set('denials', '1');
  if (options?.includePaging) {
    if (filters.offset > 0) params.set('offset', String(filters.offset));
    if (filters.limit !== AUDIT_LOG_PAGE_DEFAULT) {
      params.set('limit', String(filters.limit));
    }
  }
  return params.toString();
}

async function gate(deniedAction: AuditAction): Promise<void> {
  const ctx = requireTenantContext();
  if (hasPermission(subjectFromContext(ctx), 'audit:view')) return;
  await recordAudit({
    action: deniedAction,
    resourceType: 'audit_log',
    result: 'denied',
    reason: 'missing audit:view',
  });
  throw new AuthorizationError('PERMISSION_DENIED');
}

async function selectRows(
  filters: AuditLogFilters,
  limit: number,
  offset: number,
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const scope = currentScope();
  const where = tenantAuditWhere(scope.organisationId, filters);
  const [counted] = await scope.db
    .select({ total: count() })
    .from(auditEvents)
    .where(where);
  const total = Number(counted?.total ?? 0);
  const selected = await scope.db
    .select({
      id: auditEvents.id,
      timestamp: auditEvents.timestamp,
      actorUserId: auditEvents.actorUserId,
      actorName: users.name,
      actingRole: auditEvents.actingRole,
      action: auditEvents.action,
      resourceType: auditEvents.resourceType,
      resourceId: auditEvents.resourceId,
      result: auditEvents.result,
      reason: auditEvents.reason,
      ipAddress: auditEvents.ipAddress,
      correlationId: auditEvents.correlationId,
      beforeMeta: auditEvents.beforeMeta,
      afterMeta: auditEvents.afterMeta,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.actorUserId, users.id))
    .where(where)
    .orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
    .limit(limit)
    .offset(offset);

  const rows = selected.map((row) => ({
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    actingRole: row.actingRole,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    result: row.result,
    reason: row.reason,
    ipAddress: row.ipAddress,
    correlationId: row.correlationId,
    beforeMeta: row.beforeMeta,
    afterMeta: row.afterMeta,
  }));
  return { rows, total };
}

function viewMeta(
  surface: 'list' | 'export' | 'checklist',
  filters: AuditLogFilters,
  rowCount: number,
  truncated: boolean,
) {
  return {
    data: {
      surface,
      caseId: filters.caseId ?? '',
      actorUserId: filters.actorUserId ?? '',
      action: filters.action ?? '',
      from: filters.from?.toISOString() ?? '',
      to: filters.to?.toISOString() ?? '',
      breakGlass: filters.breakGlass,
      denials: filters.denials,
      rowCount,
      truncated,
    },
    allow: VIEW_META_ALLOW,
  };
}

async function recordInvalid(action: AuditAction): Promise<void> {
  await recordAudit({
    action,
    resourceType: 'audit_log',
    result: 'failure',
    reason: 'invalid filters',
  });
}

/** List one page of the active tenant's audit trail. The read is audited. */
export async function listAuditLog(raw: unknown): Promise<AuditLogPage> {
  await gate('audit.viewed');
  const parsed = auditLogQuerySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    await recordInvalid('audit.viewed');
    throw parsed.error;
  }
  const filters = parsed.data;
  const { rows, total } = await selectRows(filters, filters.limit, filters.offset);
  await recordAudit({
    action: 'audit.viewed',
    resourceType: 'audit_log',
    result: 'success',
    after: viewMeta('list', filters, rows.length, false),
  });
  return {
    items: rows.map(toEntry),
    total,
    limit: filters.limit,
    offset: filters.offset,
    filters,
  };
}

/** Export the active tenant's filtered trail as formula-safe CSV. */
export async function exportAuditLog(raw: unknown): Promise<AuditLogExport> {
  await gate('audit.exported');
  const parsed = auditLogQuerySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    await recordInvalid('audit.exported');
    throw parsed.error;
  }
  const filters = { ...parsed.data, limit: AUDIT_EXPORT_MAX_ROWS, offset: 0 };
  const { rows, total } = await selectRows(filters, AUDIT_EXPORT_MAX_ROWS, 0);
  const truncated = total > rows.length;
  await recordAudit({
    action: 'audit.exported',
    resourceType: 'audit_log',
    result: 'success',
    after: viewMeta('export', filters, rows.length, truncated),
  });
  const day = new Date().toISOString().slice(0, 10);
  return {
    filename: `audit-log-${day}.csv`,
    csv: auditEventsToCsv(rows),
    truncated,
    rowCount: rows.length,
  };
}

/** Recent monthly-review acknowledgements, plus an audit of this open. */
export async function viewAuditChecklist(): Promise<{
  reviews: readonly AuditLogEntry[];
}> {
  await gate('audit.viewed');
  const filters = auditLogQuerySchema.parse({
    action: 'audit.monthly_review_recorded',
    limit: 12,
  });
  const { rows } = await selectRows(filters, 12, 0);
  await recordAudit({
    action: 'audit.viewed',
    resourceType: 'audit_log',
    result: 'success',
    after: viewMeta('checklist', filters, rows.length, false),
  });
  return { reviews: rows.map(toEntry) };
}

/** Append a human acknowledgement that this month's checklist was done. */
export async function recordMonthlyAuditReview(
  raw: unknown,
): Promise<{ period: string }> {
  await gate('audit.monthly_review_recorded');
  const parsed = recordMonthlyReviewSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    await recordAudit({
      action: 'audit.monthly_review_recorded',
      resourceType: 'audit_log',
      result: 'failure',
      reason: 'invalid review',
    });
    throw parsed.error;
  }
  await recordAudit({
    action: 'audit.monthly_review_recorded',
    resourceType: 'audit_log',
    resourceId: parsed.data.period,
    result: 'success',
    reason: parsed.data.notes ?? null,
    after: {
      data: {
        period: parsed.data.period,
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      },
      allow: ['period', 'notes'],
    },
  });
  return { period: parsed.data.period };
}

function toEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    actingRole: row.actingRole,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    result: row.result,
    reason: row.reason,
  };
}
