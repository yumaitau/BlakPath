import { z } from 'zod';
import { APPLICATION_STATUSES } from '@/domains/applications/workflow';
import { REPORT_TYPES } from './reports';

/**
 * Input validation for export requests (zod v4).
 *
 * Date bounds are calendar days (YYYY-MM-DD), interpreted as inclusive UTC
 * days when the worker builds the file. Status is an application workflow
 * status and applies only to the applications report — it is not an outcome
 * and it does not decide anything.
 */

const emptyToUndefined = (value: unknown): unknown =>
  value === '' || value === null || value === undefined ? undefined : value;

const optionalDate = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
    .optional(),
);

const optionalStatus = z.preprocess(
  emptyToUndefined,
  z.enum(APPLICATION_STATUSES).optional(),
);

function datesInOrder(
  value: { from?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'The end date is before the start date.',
    });
  }
}

/** Filters stored on an export request and re-read by the worker. */
export const storedExportFilterSchema = z
  .object({
    status: optionalStatus,
    from: optionalDate,
    to: optionalDate,
  })
  .superRefine(datesInOrder);

export type StoredExportFilters = z.infer<typeof storedExportFilterSchema>;

export const requestExportSchema = z
  .object({
    type: z.enum(REPORT_TYPES),
    status: optionalStatus,
    from: optionalDate,
    to: optionalDate,
  })
  .superRefine((value, ctx) => {
    datesInOrder(value, ctx);
    if (value.status && value.type !== 'applications') {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Status filter applies to the applications report.',
      });
    }
  });
export type RequestExportInput = z.input<typeof requestExportSchema>;

/** Read persisted filters. Null params mean "no filter". Invalid params fail the export. */
export function readStoredExportFilters(params: unknown): StoredExportFilters {
  if (params == null) return {};
  const parsed = storedExportFilterSchema.safeParse(params);
  if (!parsed.success) {
    throw new Error('Export filters are invalid');
  }
  return parsed.data;
}

/** Inclusive UTC instants for a calendar-day filter. */
export function exportRange(filters: {
  from?: string | undefined;
  to?: string | undefined;
}): {
  start?: Date;
  end?: Date;
} {
  const range: { start?: Date; end?: Date } = {};
  if (filters.from) range.start = new Date(`${filters.from}T00:00:00.000Z`);
  if (filters.to) range.end = new Date(`${filters.to}T23:59:59.999Z`);
  return range;
}
