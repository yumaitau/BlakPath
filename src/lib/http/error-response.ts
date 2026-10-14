import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CalendarConflictError } from '@/domains/calendar/errors';
import { stepUpRequiredBody } from '@/lib/auth/step-up-policy';
import {
  TENANT_KEY_UNAVAILABLE_MESSAGE,
  TenantKeyUnavailableError,
} from '@/lib/encryption/errors';
import { RateLimitedError } from '@/lib/http/request-limits';
import { logger } from '@/lib/observability/logger';
import {
  correlationFromHeaders,
  currentRequestIds,
  newId,
  runWithRequestIds,
} from '@/lib/observability/correlation';
import { isAuthorizationError } from '@/lib/permissions/errors';

/**
 * One mapper for every API route.
 *
 * The body is always `{ error, code, requestId }`. `error` is a fixed phrase,
 * never `Error.message` — messages from Zod, JSON.parse, and the database can
 * echo the request (names, addresses, tokens). Authorisation and tenancy
 * failures share `FORBIDDEN` so a caller cannot tell "denied" from "absent".
 * Step-up, MFA, and resource-conflict keep their own codes because the client
 * acts on them.
 *
 * Unknown errors are the only ones logged. The log record is a sanitised
 * summary (name, stable code, stack frames) — not the message and not own
 * properties, which is where applicant data and secrets show up.
 */

/** A failure whose message is a constant we chose and is safe to return. */
export class ClientSafeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ClientSafeError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiErrorBody {
  error: string;
  code: string;
  requestId: string;
}

const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;

/**
 * Fixed-shape mappings. Status and `error` text match the mappers this file
 * replaced; clients and tests depend on both.
 */
const BY_NAME: Record<string, { status: number; code: string; error: string }> = {
  UnauthenticatedError: { status: 401, code: 'UNAUTHENTICATED', error: 'Unauthorized' },
  ApiKeyError: { status: 401, code: 'API_KEY_INVALID', error: 'Unauthorized' },
  NoActiveOrganisationError: {
    status: 409,
    code: 'NO_ACTIVE_ORGANISATION',
    error: 'No active organisation',
  },
  WebhookDestinationError: {
    status: 400,
    code: 'VALIDATION_ERROR',
    error: 'Invalid request',
  },
  OrganisationKeyInputError: {
    status: 400,
    code: 'VALIDATION_ERROR',
    error: 'Invalid request',
  },
  OrganisationActivationError: {
    status: 409,
    code: 'KEY_NOT_VALIDATED',
    error: 'Organisation cannot become active',
  },
  ApplicationWorkflowError: {
    status: 409,
    code: 'INVALID_TRANSITION',
    error: 'Invalid transition',
  },
  // The row stays pending. Do not echo object keys or sizes.
  EvidenceUploadIncompleteError: {
    status: 409,
    code: 'EVIDENCE_UPLOAD_INCOMPLETE',
    error: 'Upload incomplete',
  },
  DecisionWorkflowError: {
    status: 409,
    code: 'CASE_NOT_READY_FOR_DECISION',
    error: 'Case is not ready for a committee decision',
  },
  CertificateConflictError: {
    status: 409,
    code: 'CERTIFICATE_ALREADY_LIVE',
    error: 'A live certificate already exists for this decision',
  },
  FormTokenError: {
    status: 404,
    code: 'FORM_TOKEN_INVALID',
    error: 'This form link is invalid or has expired.',
  },
  // Platform-operator lifecycle routes only; tenant routes never throw it.
  OrganisationNotFoundError: { status: 404, code: 'NOT_FOUND', error: 'Not found' },
  BreakGlassError: { status: 403, code: 'FORBIDDEN', error: 'Forbidden' },
  TenantContextError: { status: 403, code: 'FORBIDDEN', error: 'Forbidden' },
  // A suspended or offboarded organisation looks like any other refusal.
  OrganisationUnavailableError: { status: 403, code: 'FORBIDDEN', error: 'Forbidden' },
};

interface MappedError {
  status: number;
  code: string;
  error: string;
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
}

function classify(error: unknown): MappedError {
  if (error instanceof ClientSafeError) {
    return { status: error.status, code: error.code, error: error.message };
  }
  // Calm lock: 423 when the tenant key is disabled, 503 when KMS is down.
  if (error instanceof TenantKeyUnavailableError) {
    return {
      status: error.httpStatus,
      code: error.code,
      error: TENANT_KEY_UNAVAILABLE_MESSAGE,
    };
  }
  if (error instanceof RateLimitedError) {
    const seconds = String(Math.max(1, error.retryAfter));
    return {
      status: 429,
      code: 'RATE_LIMITED',
      error: 'Too many requests',
      headers: { 'Retry-After': seconds, 'X-Retry-After': seconds },
    };
  }
  // Lost optimistic-concurrency race (src/lib/concurrency/error.ts). Its
  // message is a fixed phrase chosen at the throw site, so it is returned.
  if (error instanceof Error && error.name === 'ConcurrencyConflictError') {
    return { status: 409, code: 'CONCURRENCY_CONFLICT', error: error.message };
  }
  // Per-tenant MCP budget (src/domains/mcp/rate-limit.ts).
  if (error instanceof Error && error.name === 'McpRateLimitError') {
    const seconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    return {
      status: 429,
      code: 'RATE_LIMITED',
      error: 'Too many requests',
      headers: { 'Retry-After': String(seconds) },
    };
  }
  // Matched by name so this module does not import the auth stack (session,
  // database). Status and code come from the error itself.
  if (error instanceof Error && error.name === 'StaffMfaRequiredError') {
    const { status, code } = error as { status?: unknown; code?: unknown };
    return {
      status: typeof status === 'number' ? status : 403,
      code: typeof code === 'string' ? code : 'STAFF_MFA_REQUIRED',
      error: 'A verified second factor is required',
    };
  }
  if (error instanceof Error && error.name === 'StepUpRequiredError') {
    // The step-up dialog and the session fetch guard key off this body.
    return { status: 401, ...stepUpRequiredBody() };
  }
  // Tenant AI opt-in: a missing step-up re-prompts; missing governance is 400.
  if (error instanceof Error && error.name === 'AiFeatureChangeError') {
    return (error as { code?: unknown }).code === 'STEP_UP_REQUIRED'
      ? { status: 401, ...stepUpRequiredBody() }
      : { status: 400, code: 'VALIDATION_ERROR', error: 'Invalid request' };
  }
  if (
    error instanceof ZodError ||
    (error instanceof Error && error.name === 'ZodError')
  ) {
    return { status: 400, code: 'VALIDATION_ERROR', error: 'Invalid request' };
  }
  if (
    error instanceof SyntaxError ||
    (error instanceof Error && error.name === 'SyntaxError')
  ) {
    return { status: 400, code: 'INVALID_JSON', error: 'Invalid request' };
  }
  if (
    error instanceof CalendarConflictError ||
    (error instanceof Error && error.name === 'CalendarConflictError')
  ) {
    const rows = (error as CalendarConflictError).conflicts ?? [];
    return {
      status: 409,
      code: 'RESOURCE_CONFLICT',
      error: 'Resource conflict',
      // The signed-in member already sees these events on the calendar. The
      // client lists titles when a hard block rejects the save.
      extra: {
        conflicts: rows.map((row) => ({
          id: row.id,
          title: row.title,
          startAt: row.startAt,
        })),
      },
    };
  }
  if (isAuthorizationError(error)) {
    return { status: 403, code: 'FORBIDDEN', error: 'Forbidden' };
  }
  if (error instanceof Error) {
    const known = BY_NAME[error.name];
    if (known) return known;
  }
  return { status: 500, code: 'INTERNAL_ERROR', error: 'Internal error' };
}

/** Drop anything in a stack frame that could have been copied from user input. */
function scrub(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/\bbp_[A-Za-z0-9]+\b/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
}

/**
 * Log-safe view of an unknown failure. Omits `message` and every own property
 * (`userId`, Zod issues, SQL detail, conflict titles). Keeps the error name, a
 * stable code, and `at` stack frames so an incident can be located.
 */
export function sanitiseError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error) || depth > 2) {
    return { type: typeof error };
  }
  const out: Record<string, unknown> = { name: error.name };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && SAFE_CODE.test(code)) out.code = code;
  if (error.stack) {
    const frames = error.stack
      .split('\n')
      .map((line) => scrub(line.trim()))
      .filter((line) => line.startsWith('at '))
      .slice(0, 8);
    if (frames.length > 0) out.stack = frames.join('\n');
  }
  if (error.cause !== undefined && depth < 2) {
    out.cause = sanitiseError(error.cause, depth + 1);
  }
  return out;
}

export interface ErrorResponseOptions {
  requestId?: string;
  /** SCIM provisioning clients require the RFC 7644 error schema. */
  presentation?: 'platform' | 'scim';
}

function resolveRequestId(explicit?: string): string {
  if (explicit && SAFE_CODE.test(explicit)) return explicit;
  // Request ids are not error codes: they may contain lowercase and hyphens.
  if (explicit && /^[A-Za-z0-9._-]{1,128}$/.test(explicit)) return explicit;
  return currentRequestIds()?.requestId ?? newId();
}

/** Map a thrown error to the platform JSON error (or a SCIM error envelope). */
export function errorResponse(
  error: unknown,
  options?: ErrorResponseOptions,
): NextResponse {
  const requestId = resolveRequestId(options?.requestId);
  const mapped = classify(error);
  // ClientSafeError is a status the route chose, and a tenant-key 503 is a
  // calm lock. Log only unexpected failures.
  if (
    mapped.status >= 500 &&
    !(error instanceof ClientSafeError) &&
    !(error instanceof TenantKeyUnavailableError)
  ) {
    logger.error(
      { err: sanitiseError(error), requestId, code: mapped.code },
      'unhandled route error',
    );
  }

  if (options?.presentation === 'scim') {
    return NextResponse.json(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: String(mapped.status),
        detail: mapped.error,
        requestId,
      },
      mapped.headers
        ? { status: mapped.status, headers: mapped.headers }
        : { status: mapped.status },
    );
  }

  const body: ApiErrorBody & Record<string, unknown> = {
    error: mapped.error,
    code: mapped.code,
    requestId,
    ...mapped.extra,
  };
  return NextResponse.json(
    body,
    mapped.headers
      ? { status: mapped.status, headers: mapped.headers }
      : { status: mapped.status },
  );
}

/** Route handler arguments: `(request, { params })`, either of which may be unused. */
type RouteArgs = [request?: Request, context?: unknown];

/**
 * Own try/catch for a route handler. Reads or mints the request id, runs `fn`,
 * and turns every throw into {@link errorResponse}. The wrapper keeps `fn`'s
 * parameter list, so callers (Next.js and tests) invoke it exactly as before.
 */
export function tenantHandler<A extends RouteArgs>(
  fn: (...args: A) => Promise<Response> | Response,
  options?: Pick<ErrorResponseOptions, 'presentation'>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const ids = correlationFromHeaders(args[0]?.headers ?? new Headers());
    return runWithRequestIds(ids, async () => {
      try {
        return await fn(...args);
      } catch (error) {
        return errorResponse(
          error,
          options?.presentation
            ? { requestId: ids.requestId, presentation: options.presentation }
            : { requestId: ids.requestId },
        );
      }
    });
  };
}
