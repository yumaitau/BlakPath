/**
 * Raised when a second live certificate would be issued for one decision.
 * The database partial unique index is the authority; this error is the
 * application-facing shape of that rejection.
 */
export class CertificateConflictError extends Error {
  readonly code = 'CERTIFICATE_ALREADY_LIVE';
  readonly status = 409;

  constructor() {
    super('A live certificate already exists for this decision.');
    this.name = 'CertificateConflictError';
  }
}
