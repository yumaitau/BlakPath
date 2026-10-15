/**
 * Projections for data read under a break-glass grant.
 *
 * The grant may read application and evidence metadata. It does not receive
 * intake JSON, object-storage keys, or file bytes. Downloads stay behind
 * `evidence:download`, which the grant does not hold.
 */

export interface BreakGlassApplicationView {
  id: string;
  reference: string;
  applicantName: string;
  status: string;
  priority: string;
  createdAt: Date;
  submittedAt: Date | null;
}

export interface BreakGlassEvidenceView {
  id: string;
  applicationId: string | null;
  fileName: string;
  status: string;
  classification: string | null;
  declaredContentType: string;
  sizeBytes: number;
  createdAt: Date;
}

export function projectBreakGlassApplication(row: {
  id: string;
  reference: string;
  applicantName: string;
  status: string;
  priority: string;
  createdAt: Date;
  submittedAt: Date | null;
}): BreakGlassApplicationView {
  return {
    id: row.id,
    reference: row.reference,
    applicantName: row.applicantName,
    status: row.status,
    priority: row.priority,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
  };
}

export function projectBreakGlassEvidence(row: {
  id: string;
  applicationId: string | null;
  fileName: string;
  status: string;
  classification: string | null;
  declaredContentType: string;
  sizeBytes: number;
  createdAt: Date;
}): BreakGlassEvidenceView {
  return {
    id: row.id,
    applicationId: row.applicationId,
    fileName: row.fileName,
    status: row.status,
    classification: row.classification,
    declaredContentType: row.declaredContentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}
