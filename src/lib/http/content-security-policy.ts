/**
 * Per-request Content-Security-Policy.
 *
 * The nonce is generated in `src/proxy.ts` and forwarded on the request so
 * Next can stamp it onto the scripts and styles it renders. `strict-dynamic`
 * keeps that allow-list from turning into a host allow-list in current browsers.
 */

export const CSP_REPORT_PATH = '/api/csp-report';
export const CSP_REPORT_GROUP = 'csp-endpoint';

export function createNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}

export function buildContentSecurityPolicy(input: {
  nonce: string;
  development: boolean;
  upgradeInsecureRequests: boolean;
}): string {
  const scriptSrc = [
    "script-src 'self'",
    `'nonce-${input.nonce}'`,
    "'strict-dynamic'",
    input.development ? "'unsafe-eval'" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  // React's dev runtime evaluates code. Production does not.
  // Style attributes (drag offsets, chart sizes) are not nonceable; element
  // styles stay nonced outside development.
  const styleSrc = input.development
    ? "style-src 'self' 'unsafe-inline'"
    : `style-src 'self' 'nonce-${input.nonce}'`;

  const directives = [
    "default-src 'self'",
    scriptSrc,
    styleSrc,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    input.upgradeInsecureRequests ? 'upgrade-insecure-requests' : null,
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].filter((directive): directive is string => directive !== null);

  return directives.join('; ');
}
