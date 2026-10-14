import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STEP_UP_REQUIRED_CODE, STEP_UP_ROUTES } from '@/lib/auth/step-up-policy';

const requireRecentAuth = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/session', async () => {
  const actual = (await vi.importActual('@/lib/auth/session')) as Record<string, unknown>;
  return { ...actual, requireRecentAuth };
});

import { StepUpRequiredError } from '@/lib/auth/session';
import { POST as revokeCertificate } from '@/app/api/certificates/[id]/revoke/route';
import { GET as downloadEvidence } from '@/app/api/evidence/[id]/download/route';
import { POST as denyBreakGlass } from '@/app/api/break-glass/[id]/deny/route';
import { POST as revokeBreakGlass } from '@/app/api/break-glass/[id]/revoke/route';
import { POST as createKey } from '@/app/api/keys/route';
import { POST as requestExport } from '@/app/api/reports/exports/route';
import { GET as downloadExport } from '@/app/api/reports/exports/[id]/download/route';
import { DELETE as releaseHold } from '@/app/api/retention/holds/[id]/route';
import { DELETE as deletePolicy } from '@/app/api/retention/policies/[id]/route';
import { POST as createSso } from '@/app/api/sso/providers/route';
import { POST as createWebhook } from '@/app/api/webhooks/route';

const params = {
  params: Promise.resolve({ id: '00000000-0000-7000-8000-000000000001' }),
};

async function expectStale(response: Promise<Response>, window: number): Promise<void> {
  const result = await response;
  expect(result.status).toBe(401);
  await expect(result.json()).resolves.toMatchObject({ code: STEP_UP_REQUIRED_CODE });
  expect(requireRecentAuth).toHaveBeenCalledWith(window);
}

describe('listed routes require a fresh session', () => {
  beforeEach(() => {
    requireRecentAuth.mockReset();
    requireRecentAuth.mockRejectedValue(new StepUpRequiredError(1));
  });

  it('returns STEP_UP_REQUIRED for each mapped handler', async () => {
    const post = () => new Request('http://localhost/step-up', { method: 'POST' });
    await expectStale(
      downloadEvidence(new Request('http://localhost/evidence'), params),
      STEP_UP_ROUTES['GET /api/evidence/[id]/download'],
    );
    requireRecentAuth.mockClear();
    await expectStale(
      requestExport(post() as never),
      STEP_UP_ROUTES['POST /api/reports/exports'],
    );
    requireRecentAuth.mockClear();
    await expectStale(
      downloadExport(new Request('http://localhost/export'), params),
      STEP_UP_ROUTES['GET /api/reports/exports/[id]/download'],
    );
    requireRecentAuth.mockClear();
    await expectStale(
      revokeCertificate(post() as never, params),
      STEP_UP_ROUTES['POST /api/certificates/[id]/revoke'],
    );
    requireRecentAuth.mockClear();
    await expectStale(createKey(post() as never), STEP_UP_ROUTES['POST /api/keys']);
    requireRecentAuth.mockClear();
    await expectStale(
      createWebhook(post() as never),
      STEP_UP_ROUTES['POST /api/webhooks'],
    );
    requireRecentAuth.mockClear();
    await expectStale(
      createSso(post() as never),
      STEP_UP_ROUTES['POST /api/sso/providers'],
    );
    requireRecentAuth.mockClear();
    await expectStale(
      releaseHold(new Request('http://localhost/hold', { method: 'DELETE' }), params),
      STEP_UP_ROUTES['DELETE /api/retention/holds/[id]'],
    );
    requireRecentAuth.mockClear();
    await expectStale(
      deletePolicy(new Request('http://localhost/policy', { method: 'DELETE' }), params),
      STEP_UP_ROUTES['DELETE /api/retention/policies/[id]'],
    );
    requireRecentAuth.mockClear();
    await expectStale(
      denyBreakGlass(post() as never, params),
      STEP_UP_ROUTES['POST /api/break-glass/[id]/deny'],
    );
    requireRecentAuth.mockClear();
    await expectStale(
      revokeBreakGlass(
        new Request('http://localhost/revoke', { method: 'POST' }),
        params,
      ),
      STEP_UP_ROUTES['POST /api/break-glass/[id]/revoke'],
    );
  });
});
