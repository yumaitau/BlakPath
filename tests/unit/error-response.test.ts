import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as listV1Applications } from '@/app/api/v1/applications/route';
import { ApplicationWorkflowError } from '@/domains/applications/workflow';
import { ApiKeyError } from '@/domains/api-keys';
import { BreakGlassError } from '@/domains/break-glass';
import { CalendarConflictError } from '@/domains/calendar/errors';
import { FormResponseLinkError, FormTokenError } from '@/domains/forms';
import { StaffMfaRequiredError } from '@/lib/auth/staff-policy';
import { StepUpRequiredError, UnauthenticatedError } from '@/lib/auth/session';
import {
  ClientSafeError,
  errorResponse,
  sanitiseError,
  tenantHandler,
} from '@/lib/http/error-response';
import { NoActiveOrganisationError } from '@/lib/http/tenant-route';
import { RateLimitedError } from '@/lib/http/request-limits';
import {
  CONCURRENCY_CONFLICT_MESSAGE,
  ConcurrencyConflictError,
} from '@/lib/concurrency/error';
import { TenantKeyUnavailableError } from '@/lib/encryption/errors';
import { CertificateConflictError } from '@/domains/certificates/errors';
import { DecisionWorkflowError } from '@/domains/decisions/errors';
import {
  OrganisationActivationError,
  OrganisationKeyInputError,
} from '@/domains/organisation-keys';
import { WebhookDestinationError } from '@/domains/webhooks/destination';
import { EvidenceUploadIncompleteError } from '@/domains/evidence/errors';
import { RetentionError, RetentionTargetError } from '@/domains/retention';
import { CorrespondenceError } from '@/domains/correspondence/errors';
import { OrganisationUnavailableError } from '@/lib/tenancy/organisation-status';
import { logger } from '@/lib/observability/logger';
import { AuthorizationError } from '@/lib/permissions/errors';
import { TenantContextError, TenantIsolationError } from '@/lib/tenancy/context';
import { BreakGlassWriteError } from '@/lib/tenancy/break-glass-write';

async function bodyOf(error: unknown, requestId = 'req-test') {
  const response = errorResponse(error, { requestId });
  return { status: response.status, body: await response.json() };
}

describe('errorResponse', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps validation, JSON, step-up, MFA, and conflict errors', async () => {
    const zod = z.object({ limit: z.coerce.number().int() }).safeParse({ limit: 'abc' });
    expect(zod.success).toBe(false);
    if (zod.success) return;
    const validation = await bodyOf(zod.error);
    expect(validation.status).toBe(400);
    expect(validation.body).toMatchObject({
      error: 'Invalid request',
      code: 'VALIDATION_ERROR',
      requestId: 'req-test',
    });

    const syntax = await bodyOf(
      new SyntaxError('Unexpected token < in JSON at position 0'),
    );
    expect(syntax.status).toBe(400);
    expect(syntax.body.code).toBe('INVALID_JSON');
    expect(syntax.body.error).toBe('Invalid request');
    expect(JSON.stringify(syntax.body)).not.toContain('Unexpected token');

    const stepUp = await bodyOf(new StepUpRequiredError(300));
    expect(stepUp.status).toBe(401);
    expect(stepUp.body).toMatchObject({
      error: 'Re-authentication required',
      code: 'STEP_UP_REQUIRED',
    });

    const mfa = await bodyOf(new StaffMfaRequiredError('user-secret-id'));
    expect(mfa.status).toBe(403);
    expect(mfa.body.code).toBe('STAFF_MFA_REQUIRED');
    expect(JSON.stringify(mfa.body)).not.toContain('user-secret-id');

    const conflict = await bodyOf(
      new CalendarConflictError([
        {
          id: 'evt-1',
          title: 'Committee',
          startAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ] as never),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('RESOURCE_CONFLICT');
    expect(conflict.body.error).toBe('Resource conflict');
    expect(conflict.body.requestId).toBe('req-test');
    expect(conflict.body.conflicts).toEqual([
      {
        id: 'evt-1',
        title: 'Committee',
        startAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('collapses authz and tenancy failures and maps the other domain errors', async () => {
    for (const error of [
      new AuthorizationError('SEPARATION_OF_DUTIES'),
      new TenantContextError('missing org org-123'),
      new BreakGlassError(),
      new BreakGlassWriteError(),
    ]) {
      const mapped = await bodyOf(error);
      expect(mapped.status).toBe(403);
      expect(mapped.body).toMatchObject({ error: 'Forbidden', code: 'FORBIDDEN' });
      expect(JSON.stringify(mapped.body)).not.toContain('SEPARATION');
      expect(JSON.stringify(mapped.body)).not.toContain('org-123');
    }

    expect((await bodyOf(new UnauthenticatedError())).body.code).toBe('UNAUTHENTICATED');
    expect((await bodyOf(new ApiKeyError())).status).toBe(401);
    expect((await bodyOf(new ApiKeyError())).body.code).toBe('API_KEY_INVALID');
    expect((await bodyOf(new NoActiveOrganisationError())).status).toBe(409);
    expect((await bodyOf(new ApplicationWorkflowError('submit', 'draft'))).status).toBe(
      409,
    );
    expect(
      (await bodyOf(new ApplicationWorkflowError('submit', 'draft'))).body.code,
    ).toBe('INVALID_TRANSITION');
    expect((await bodyOf(new FormTokenError())).status).toBe(404);
    expect((await bodyOf(new FormTokenError())).body.code).toBe('FORM_TOKEN_INVALID');
    expect(
      (
        await bodyOf(
          new ClientSafeError(400, 'VALIDATION_ERROR', 'Some answers are invalid.'),
        )
      ).body,
    ).toMatchObject({ error: 'Some answers are invalid.', code: 'VALIDATION_ERROR' });
  });

  it('keeps the status and text of every mapping the old route mappers had', async () => {
    const locked = await bodyOf(new TenantKeyUnavailableError('org-1', 423));
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('TENANT_KEY_UNAVAILABLE');
    expect(JSON.stringify(locked.body)).not.toContain('org-1');
    expect((await bodyOf(new TenantKeyUnavailableError('org-1', 503))).status).toBe(503);

    const limited = errorResponse(new RateLimitedError(0), { requestId: 'req-test' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('1');
    expect(limited.headers.get('X-Retry-After')).toBe('1');
    expect(await limited.json()).toMatchObject({ error: 'Too many requests' });

    const cases: [unknown, number, string][] = [
      [new NoActiveOrganisationError(), 409, 'No active organisation'],
      [new WebhookDestinationError(), 400, 'Invalid request'],
      [new OrganisationKeyInputError(), 400, 'Invalid request'],
      [new OrganisationActivationError(), 409, 'Organisation cannot become active'],
      [
        new DecisionWorkflowError('in_review'),
        409,
        'Case is not ready for a committee decision',
      ],
      [
        new CertificateConflictError(),
        409,
        'A live certificate already exists for this decision',
      ],
      [new OrganisationUnavailableError(), 403, 'Forbidden'],
      [new ConcurrencyConflictError(), 409, CONCURRENCY_CONFLICT_MESSAGE],
      [new EvidenceUploadIncompleteError('missing'), 409, 'Upload incomplete'],
      [new RetentionTargetError(), 404, 'Legal hold target does not exist'],
      [new FormResponseLinkError(), 409, 'This response is already linked to a case.'],
      [
        new RetentionError(
          'SIGN_OFF_REQUIRED',
          'A records manager must sign the disposal authority for this class before a purge can be scheduled.',
        ),
        409,
        'A records manager must sign the disposal authority for this class before a purge can be scheduled.',
      ],
      [
        new RetentionError('ALREADY_ACTIVE', 'This policy is already active.'),
        409,
        'This policy is already active.',
      ],
      [new EvidenceUploadIncompleteError('size-mismatch'), 409, 'Upload incomplete'],
      [
        new ConcurrencyConflictError('This form was already submitted.'),
        409,
        'This form was already submitted.',
      ],
    ];
    for (const [error, status, text] of cases) {
      const mapped = await bodyOf(error);
      expect(mapped.status).toBe(status);
      expect(mapped.body.error).toBe(text);
    }

    const notFinalised = await bodyOf(new CorrespondenceError('decision_not_finalised'));
    expect(notFinalised.status).toBe(409);
    expect(notFinalised.body).toMatchObject({
      code: 'CORRESPONDENCE_DECISION_NOT_FINALISED',
      error:
        'An outcome letter cannot be sent until an authorised person has finalised the decision.',
    });
    const field = await bodyOf(
      new CorrespondenceError('unknown_merge_field', 'applicant.dob'),
    );
    expect(field.body.error).toBe(
      'A template uses a merge field that is not allowed. (applicant.dob)',
    );
    // Free text in the detail is never echoed.
    const unsafe = await bodyOf(
      new CorrespondenceError('unknown_merge_field', 'Jane Citizen <jane@example.org>'),
    );
    expect(unsafe.body.error).toBe('A template uses a merge field that is not allowed.');
    expect(unsafe.body.code).toBe('CORRESPONDENCE_UNKNOWN_MERGE_FIELD');

    const mfa = await bodyOf(new StaffMfaRequiredError('user-1'));
    expect(mfa.body).toMatchObject({
      error: 'A verified second factor is required',
      code: 'STAFF_MFA_REQUIRED',
    });
  });

  it('logs unknown errors with the request id and no message or PII', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const secret = 'person@example.com';
    const error = new Error(`update failed for ${secret}`);
    (error as Error & { userId: string }).userId = 'user-123';
    error.cause = new TenantIsolationError(`row ${secret}`);

    const mapped = await bodyOf(error, 'req-500');
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: 'Internal error',
      code: 'INTERNAL_ERROR',
      requestId: 'req-500',
    });
    expect(JSON.stringify(mapped.body)).not.toContain(secret);

    expect(spy).toHaveBeenCalledOnce();
    const logged = JSON.stringify(spy.mock.calls[0]);
    expect(logged).toContain('req-500');
    expect(logged).toContain('INTERNAL_ERROR');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('user-123');
    expect(logged).not.toContain('update failed');
  });

  it('does not log expected client errors', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const zod = z.object({ limit: z.coerce.number().int() }).safeParse({ limit: 'abc' });
    if (!zod.success) await bodyOf(zod.error);
    await bodyOf(new UnauthenticatedError());
    await bodyOf(new ClientSafeError(503, 'NOT_CONFIGURED', 'Not configured'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('sanitiseError keeps name, code, and frames only', () => {
    const error = new Error('token bp_live_secret for person@example.com');
    (error as Error & { code: string }).code = '23505';
    const safe = sanitiseError(error);
    const encoded = JSON.stringify(safe);
    expect(safe.name).toBe('Error');
    expect(safe.code).toBe('23505');
    expect(encoded).not.toContain('person@example.com');
    expect(encoded).not.toContain('bp_live_secret');
    expect(encoded).not.toContain('token bp_live');
  });
});

describe('tenantHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 for GET /api/v1/applications?limit=abc before the key is checked', async () => {
    const response = await listV1Applications(
      new Request('http://localhost/api/v1/applications?limit=abc', {
        headers: { 'x-request-id': 'trace-v1' },
      }) as NextRequest,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: 'Invalid request',
      code: 'VALIDATION_ERROR',
      requestId: 'trace-v1',
    });
    expect(JSON.stringify(body)).not.toContain('NaN');
  });

  it('returns 400 for an invalid v1-style query and echoes a safe request id', async () => {
    const handler = tenantHandler(async (_request: Request) => {
      z.object({ limit: z.coerce.number().int().min(1) }).parse({ limit: 'abc' });
      return new Response('ok');
    });
    const response = await handler(
      new Request('http://localhost/api/v1/applications?limit=abc', {
        headers: { 'x-request-id': 'trace-1' },
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: 'Invalid request',
      code: 'VALIDATION_ERROR',
      requestId: 'trace-1',
    });
  });

  it('replaces a request id that could forge a log line', async () => {
    // A minted id is a UUIDv7. The forged values use the non-hex marker
    // "injected" so a random id can never contain it by chance.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const forgedId = 'injected\nlevel=info msg=forged';
    const forged = errorResponse(new Error('boom person@example.com'), {
      requestId: forgedId,
    });
    const forgedBody = await forged.json();
    expect(forged.status).toBe(500);
    expect(forgedBody.requestId).not.toBe(forgedId);
    expect(forgedBody.requestId).toMatch(UUID);
    expect(forgedBody.requestId).not.toMatch(/[\r\n]/);
    expect(forgedBody.requestId).not.toContain('injected');
    const directLog = JSON.stringify(spy.mock.calls[0]);
    expect(directLog).toContain(forgedBody.requestId);
    expect(directLog).not.toContain('person@example.com');
    expect(directLog).not.toContain('injected');
    expect(directLog).not.toContain('forged');
    spy.mockClear();

    // Fetch rejects a raw newline in a header. A space is legal on the wire
    // and still fails the identifier pattern, so the handler mints a new id.
    const headerId = 'injected id';
    const handler = tenantHandler(async (_request: Request) => {
      throw new Error('boom person@example.com');
    });
    const response = await handler(
      new Request('http://localhost/api', {
        headers: { 'x-request-id': headerId },
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.requestId).not.toBe(headerId);
    expect(body.requestId).toMatch(UUID);
    expect(body.requestId).not.toContain(' ');
    expect(body.requestId).not.toContain('injected');
    const logged = JSON.stringify(spy.mock.calls[0]);
    expect(logged).toContain(body.requestId);
    expect(logged).not.toContain('person@example.com');
    expect(logged).not.toContain('injected');
  });

  it('renders SCIM provisioning errors in the RFC envelope', async () => {
    const handler = tenantHandler(
      async (_request: Request) => {
        throw new AuthorizationError('POLICY_DENIED');
      },
      { presentation: 'scim' },
    );
    const response = await handler(new Request('http://localhost/api/scim'));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(body.status).toBe('403');
    expect(body.detail).toBe('Forbidden');
    expect(body.requestId).toEqual(expect.any(String));
  });
});
