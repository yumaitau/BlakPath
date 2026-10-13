/**
 * Expected certificate failures that are safe to describe to the caller.
 * They carry no applicant detail.
 */

/** Generate or re-issue was asked before the organisation published a template. */
export class CertificateTemplateRequiredError extends Error {
  readonly code = 'CERTIFICATE_TEMPLATE_REQUIRED';
  constructor() {
    super('Publish a certificate template before generating a certificate.');
    this.name = 'CertificateTemplateRequiredError';
  }
}

/** Logo bytes failed the type or size check. Message is safe to return. */
export class CertificateTemplateInputError extends Error {
  readonly code = 'CERTIFICATE_TEMPLATE_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'CertificateTemplateInputError';
  }
}
