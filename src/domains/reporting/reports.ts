import { DESTRUCTION_REGISTER_COLUMNS } from '@/domains/retention/register';

/**
 * Report registry — the closed set of exportable datasets and their columns.
 *
 * Pure metadata (no IO): the worker uses these headers, and the request schema
 * validates against the type list. Adding a report is a matter of listing its
 * type + columns here and adding its query in `generate.ts`.
 *
 * PRODUCT INVARIANT: reports summarise and list human work. Nothing here scores
 * or determines a person's Aboriginality.
 */

export const REPORT_TYPES = [
  'applications',
  'decisions',
  'certificates',
  'destruction_register',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** CSV column headers for each report, in order. */
export const REPORT_COLUMNS: Record<ReportType, readonly string[]> = {
  applications: [
    'Reference',
    'Applicant name',
    'Status',
    'Priority',
    'Created',
    'Submitted',
    'Decided',
  ],
  decisions: ['Application', 'Proposed outcome', 'Final outcome', 'Status', 'Finalised'],
  certificates: ['Reference', 'Status', 'Signed', 'Revoked'],
  destruction_register: DESTRUCTION_REGISTER_COLUMNS,
};

export function isReportType(value: string): value is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(value);
}
