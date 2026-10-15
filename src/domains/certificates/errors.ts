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

/**
 * Generate or re-issue was asked before the organisation published a template.
 * Mapped by name in `src/lib/http/error-response.ts`; carries no applicant detail.
 */
export class CertificateTemplateRequiredError extends Error {
  readonly code = 'CERTIFICATE_TEMPLATE_REQUIRED';
  constructor() {
    super('Publish a certificate template before generating a certificate.');
    this.name = 'CertificateTemplateRequiredError';
  }
}

/**
 * Logo bytes failed the type or size check. The route returns a fixed phrase
 * (see `error-response.ts`), never this message.
 */
export class CertificateTemplateInputError extends Error {
  readonly code = 'CERTIFICATE_TEMPLATE_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'CertificateTemplateInputError';
  }
}
