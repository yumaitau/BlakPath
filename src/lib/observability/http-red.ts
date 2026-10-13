import { SpanKind } from '@opentelemetry/api';
import { isProbeRoute, normalizeHttpRoute } from './route-label';

/**
 * Derive a RED observation from a server span, then strip attributes that can
 * carry tokens or query secrets before the span is exported.
 */

const DROP_KEYS = new Set([
  'http.url',
  'url.full',
  'url.query',
  'http.target',
  'url.path',
  'db.statement',
  'db.query.text',
]);

export interface SpanLike {
  kind: number;
  attributes: Record<string, unknown>;
  startTime: readonly [number, number];
  endTime: readonly [number, number];
}

export interface RedObservation {
  route: string;
  status: number;
  durationMs: number;
}

export function spanDurationMs(
  start: readonly [number, number],
  end: readonly [number, number],
): number {
  const ms = (end[0] - start[0]) * 1000 + (end[1] - start[1]) / 1e6;
  return ms < 0 ? 0 : ms;
}

function attributeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rawRoute(attributes: Record<string, unknown>): string {
  for (const key of ['http.route', 'url.path', 'http.target', 'url.full', 'http.url']) {
    const value = attributes[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'unknown';
}

/**
 * Server spans only. Probe routes return null so they stay out of RED.
 * The route is normalised but not attached to the metric (cardinality).
 */
export function httpObservationFromSpan(span: SpanLike): RedObservation | null {
  if (span.kind !== SpanKind.SERVER) return null;
  const route = normalizeHttpRoute(rawRoute(span.attributes));
  if (isProbeRoute(route)) return null;
  const status = attributeNumber(
    span.attributes['http.response.status_code'] ?? span.attributes['http.status_code'],
  );
  return {
    route,
    status,
    durationMs: spanDurationMs(span.startTime, span.endTime),
  };
}

/** Mutates span attributes. Exported traces keep a normalised route only. */
export function scrubSpanAttributes(span: { attributes: Record<string, unknown> }): void {
  const attributes = span.attributes;
  const route = normalizeHttpRoute(rawRoute(attributes));
  for (const key of Object.keys(attributes)) {
    const lower = key.toLowerCase();
    if (
      DROP_KEYS.has(key) ||
      lower.includes('authorization') ||
      lower.includes('cookie') ||
      lower.includes('set-cookie')
    ) {
      delete attributes[key];
    }
  }
  if (route !== 'unknown') attributes['http.route'] = route;
}
