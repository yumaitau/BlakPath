import { AsyncLocalStorage } from 'node:async_hooks';
import { uuidv7 } from 'uuidv7';

/**
 * Correlation and request identifiers.
 *
 * A `correlationId` traces a logical operation across process and service
 * boundaries (web request -> queued job -> worker). A `requestId` identifies a
 * single inbound request. Both are safe to log: they are opaque, contain no
 * personal information, and let operators join OPERATIONAL logs and traces
 * without ever touching applicant data.
 */

/** Canonical header names used to propagate identifiers across boundaries. */
export const CORRELATION_HEADER = 'x-correlation-id';
export const REQUEST_HEADER = 'x-request-id';

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Generate a fresh, sortable identifier (UUIDv7). */
export function newId(): string {
  return uuidv7();
}

/**
 * Only accept caller-supplied identifiers that look like identifiers. This
 * prevents header injection (CRLF, log forging) from untrusted clients while
 * still honouring upstream trace propagation.
 */
function sanitiseId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return ID_PATTERN.test(trimmed) ? trimmed : null;
}

export interface CorrelationIds {
  correlationId: string;
  requestId: string;
}

/**
 * Read correlation/request ids from inbound headers, minting new ones when
 * absent or malformed. Accepts a `Headers` instance or a plain record.
 */
export function correlationFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): CorrelationIds {
  const read = (name: string): string | null => {
    if (headers instanceof Headers) return sanitiseId(headers.get(name));
    const raw = headers[name] ?? headers[name.toLowerCase()];
    return sanitiseId(Array.isArray(raw) ? raw[0] : raw);
  };

  return {
    correlationId: read(CORRELATION_HEADER) ?? newId(),
    requestId: read(REQUEST_HEADER) ?? newId(),
  };
}

const requestIds = new AsyncLocalStorage<CorrelationIds>();

/**
 * Bind the inbound request's ids for the rest of the handler (and anything it
 * awaits). Route wrappers set this once so the error log, the JSON body, and
 * the tenant context all share one request id.
 */
export function runWithRequestIds<T>(
  ids: CorrelationIds,
  fn: () => Promise<T>,
): Promise<T> {
  return requestIds.run(ids, fn);
}

/** Ids for the active request, or `undefined` outside a route wrapper. */
export function currentRequestIds(): CorrelationIds | undefined {
  return requestIds.getStore();
}
