import type { CsvCell } from '@/domains/reporting/csv';

/**
 * Destruction register columns, in export order.
 *
 * A row is written only when a purge actually commits. The register is itself
 * a retention-control record and is not a sweep target.
 */

export const DESTRUCTION_REGISTER_COLUMNS = [
  'Destroyed at',
  'Resource type',
  'Resource id',
  'Disposal class',
  'Jurisdiction',
  'Authority reference',
  'Policy id',
  'Correlation id',
] as const;

export interface DestructionRegisterEntry {
  readonly destroyedAt: Date;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly disposalClass: string;
  readonly jurisdiction: string;
  readonly authorityReference: string;
  readonly policyId: string;
  readonly correlationId: string;
}

export function destructionRegisterRows(
  entries: readonly DestructionRegisterEntry[],
): CsvCell[][] {
  return entries.map((entry) => [
    entry.destroyedAt,
    entry.resourceType,
    entry.resourceId,
    entry.disposalClass,
    entry.jurisdiction,
    entry.authorityReference,
    entry.policyId,
    entry.correlationId,
  ]);
}
