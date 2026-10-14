import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requirePlatformOperator = vi.hoisted(() => vi.fn());
const clearSuppression = vi.hoisted(() => vi.fn());

vi.mock('@/lib/http/platform-route', () => ({
  requirePlatformOperator,
  breakGlassErrorResponse: () =>
    new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
}));

vi.mock('@/domains/email', () => ({ clearSuppression }));

import { POST } from '@/app/api/admin/email-suppressions/route';

const OPERATOR = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  requirePlatformOperator.mockReset();
  clearSuppression.mockReset();
});

describe('POST /api/admin/email-suppressions', () => {
  it('clears using the authenticated operator, not a body actor', async () => {
    requirePlatformOperator.mockResolvedValue({ userId: OPERATOR });
    clearSuppression.mockResolvedValue({ cleared: true });
    const response = await POST(
      new NextRequest('http://localhost/api/admin/email-suppressions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: 'person@example.org',
          reason: 'mailbox restored',
          actorUserId: '00000000-0000-4000-8000-000000000099',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cleared: true });
    expect(clearSuppression).toHaveBeenCalledWith({
      address: 'person@example.org',
      actorUserId: OPERATOR,
      reason: 'mailbox restored',
    });
  });

  it('returns 400 when the address is rejected', async () => {
    requirePlatformOperator.mockResolvedValue({ userId: OPERATOR });
    const { ZodError } = await import('zod');
    clearSuppression.mockRejectedValue(new ZodError([]));
    const response = await POST(
      new NextRequest('http://localhost/api/admin/email-suppressions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'nope' }),
      }),
    );
    expect(response.status).toBe(400);
  });
});
