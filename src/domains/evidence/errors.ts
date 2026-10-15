/**
 * The caller said the upload finished, but the quarantine object is missing or
 * the wrong size. The evidence row must stay `pending` so a later PUT can
 * complete. Mapped to HTTP 409 by the route helper.
 */
export class EvidenceUploadIncompleteError extends Error {
  readonly code = 'EVIDENCE_UPLOAD_INCOMPLETE';
  readonly status = 409;

  constructor(readonly reason: 'missing' | 'size-mismatch') {
    super(
      reason === 'missing'
        ? 'The upload has not arrived in quarantine.'
        : 'The uploaded object size does not match the declared size.',
    );
    this.name = 'EvidenceUploadIncompleteError';
  }
}
