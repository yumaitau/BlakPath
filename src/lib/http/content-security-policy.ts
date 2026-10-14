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

/**
 * Origin the browser PUTs evidence to with a presigned URL. Uploads go to the
 * quarantine bucket only, so that is the one host `connect-src` must allow.
 */
export function uploadOrigin(input: {
  endpoint: string | undefined;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
}): string {
  if (input.endpoint) {
    const endpoint = new URL(input.endpoint);
    if (input.forcePathStyle) return endpoint.origin;
    return `${endpoint.protocol}//${input.bucket}.${endpoint.host}`;
  }
  const host = `s3.${input.region}.amazonaws.com`;
  return input.forcePathStyle ? `https://${host}` : `https://${input.bucket}.${host}`;
}

export function buildContentSecurityPolicy(input: {
  nonce: string;
  development: boolean;
  upgradeInsecureRequests: boolean;
  /** Extra origins fetch() may reach, such as the evidence upload bucket. */
  connectSources?: readonly string[];
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
    ["connect-src 'self'", ...(input.connectSources ?? [])].join(' '),
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
