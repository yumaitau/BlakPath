import { describe, expect, it, vi } from 'vitest';
import { ConcurrencyConflictError } from '@/lib/concurrency/error';
import { readConflictMessage } from '@/lib/http/conflict-message';
import { apiErrorResponse } from '@/lib/http/api-route';
import { toErrorResponse } from '@/lib/http/tenant-route';

vi.mock('@/domains/forms', () => {
  class FormTokenError extends Error {
    readonly code = 'FORM_TOKEN_INVALID';
    readonly status = 404;
    constructor() {
      super('This form link is invalid or has expired.');
      this.name = 'FormTokenError';
    }
  }
  return {
    FormTokenError,
    submitPublicResponse: vi.fn(),
  };
});

describe('concurrency conflict responses', () => {
  it('maps a lost race to 409 with the caller message', async () => {
    const error = new ConcurrencyConflictError(
      'This application changed while you were working. Refresh and try again.',
    );
    const response = toErrorResponse(error);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: error.message });

    const api = apiErrorResponse(error);
    expect(api.status).toBe(409);
    await expect(api.json()).resolves.toEqual({ error: error.message });
  });

  it('reads a 409 message for the UI and ignores other statuses', async () => {
    const conflict = new Response(
      JSON.stringify({
        error: 'This certificate was already signed or changed. Refresh and try again.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
    await expect(readConflictMessage(conflict)).resolves.toBe(
      'This certificate was already signed or changed. Refresh and try again.',
    );

    const forbidden = new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
    });
    await expect(readConflictMessage(forbidden)).resolves.toBeNull();
  });

  it('returns 409 from the public form submit route', async () => {
    const forms = await import('@/domains/forms');
    vi.mocked(forms.submitPublicResponse).mockRejectedValueOnce(
      new ConcurrencyConflictError('This form was already submitted.'),
    );
    const { POST } = await import('@/app/api/public/forms/[token]/route');
    const response = await POST(
      new Request('http://localhost/api/public/forms/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { supplied_name: 'Ada' } }),
      }) as never,
      { params: Promise.resolve({ token: 'token' }) },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'This form was already submitted.',
    });
  });
});
