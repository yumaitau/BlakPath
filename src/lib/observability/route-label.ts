/**
 * Low-cardinality HTTP route labels.
 *
 * Raw paths can carry invitation tokens, verification codes and object ids.
 * Metrics and exported spans keep the shape of the route, not the value.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const LONG_TOKEN = /[A-Za-z0-9_-]{20,}/g;
const NUMERIC_ID = /\/\d+(?=\/|$)/g;

const PROBES = new Set(['/api/health', '/api/ready', '/api/live']);

/** Drop query strings, fragments and high-cardinality path segments. */
export function normalizeHttpRoute(raw: string): string {
  const withoutQuery = raw.split('?')[0]?.split('#')[0] ?? '/';
  const path = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  return path
    .replace(UUID, ':id')
    .replace(LONG_TOKEN, ':token')
    .replace(NUMERIC_ID, '/:id')
    .slice(0, 160);
}

/** Load-balancer probes must not dominate RED or the availability SLO. */
export function isProbeRoute(route: string): boolean {
  return PROBES.has(route);
}
