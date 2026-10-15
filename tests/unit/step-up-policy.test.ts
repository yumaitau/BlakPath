import { describe, expect, it } from 'vitest';
import {
  STEP_UP_REQUIRED_CODE,
  STEP_UP_ROUTES,
  STEP_UP_WINDOWS,
  isAuthenticationStale,
  stepUpRequiredBody,
} from '@/lib/auth/step-up-policy';
import {
  STAFF_IDLE_TIMEOUT_DEFAULT_SECONDS,
  STAFF_IDLE_TIMEOUT_MAX_SECONDS,
  STAFF_IDLE_TIMEOUT_MIN_SECONDS,
  STAFF_SESSION_ABSOLUTE_SECONDS,
  evaluateStaffSession,
  resolveStaffIdleTimeoutSeconds,
} from '@/lib/auth/staff-session-policy';
import { hotp, matchBackupCode, totpMatches } from '@/lib/auth/totp';
import { openStepUpContext, sealStepUpContext } from '@/lib/auth/step-up-context-cookie';
import { responseNeedsStepUp, withStepUp } from '@/lib/auth/step-up-flow';
import { StepUpRequiredError } from '@/lib/auth/session';
import { errorResponse } from '@/lib/http/error-response';

const LISTED_ROUTES = [
  'GET /api/evidence/[id]/download',
  'POST /api/reports/exports',
  'GET /api/reports/exports/[id]/download',
  'POST /api/certificates/[id]/revoke',
  'POST /api/certificates/[id]/reissue',
  'GET /api/meetings/[id]/pack',
  'POST /api/applications/[id]/correspondence/[correspondenceId]/send',
  'POST /api/applications/[id]/evidence-requests/[requestId]/notify',
  'POST /api/keys',
  'POST /api/webhooks',
  'POST /api/webhooks/[id]/deliveries/[deliveryId]/redeliver',
  'POST /api/sso/providers',
  'POST /api/organisation-domains',
  'POST /api/organisation-domains/[id]/verify',
  'DELETE /api/organisation-domains/[id]',
  'DELETE /api/retention/holds/[id]',
  'DELETE /api/retention/policies/[id]',
  'POST /api/retention/policies/[id]/activate',
  'POST /api/retention/disposal-authorities',
  'POST /api/break-glass/[id]/deny',
  'POST /api/break-glass/[id]/revoke',
  'POST /api/break-glass',
  'POST /api/break-glass/[id]/activate',
  'POST /api/break-glass/[id]/approve',
  'POST /api/break-glass/[id]/review',
] as const;

describe('step-up route map', () => {
  it('covers each listed route and no others', () => {
    expect(Object.keys(STEP_UP_ROUTES).sort()).toEqual([...LISTED_ROUTES].sort());
  });

  it('assigns the documented window to each route', () => {
    expect(STEP_UP_ROUTES['GET /api/evidence/[id]/download']).toBe(
      STEP_UP_WINDOWS.sensitiveAction,
    );
    expect(STEP_UP_ROUTES['POST /api/reports/exports']).toBe(
      STEP_UP_WINDOWS.sensitiveAction,
    );
    expect(STEP_UP_ROUTES['GET /api/reports/exports/[id]/download']).toBe(
      STEP_UP_WINDOWS.sensitiveAction,
    );
    expect(STEP_UP_ROUTES['POST /api/certificates/[id]/revoke']).toBe(
      STEP_UP_WINDOWS.sensitiveAction,
    );
    expect(STEP_UP_ROUTES['POST /api/certificates/[id]/reissue']).toBe(
      STEP_UP_WINDOWS.sensitiveAction,
    );
    expect(STEP_UP_ROUTES['GET /api/meetings/[id]/pack']).toBe(
      STEP_UP_WINDOWS.sensitiveAction,
    );
    expect(
      STEP_UP_ROUTES[
        'POST /api/applications/[id]/correspondence/[correspondenceId]/send'
      ],
    ).toBe(STEP_UP_WINDOWS.sensitiveAction);
    expect(
      STEP_UP_ROUTES['POST /api/applications/[id]/evidence-requests/[requestId]/notify'],
    ).toBe(STEP_UP_WINDOWS.sensitiveAction);
    expect(STEP_UP_ROUTES['POST /api/keys']).toBe(STEP_UP_WINDOWS.privileged);
    expect(STEP_UP_ROUTES['POST /api/webhooks']).toBe(STEP_UP_WINDOWS.privileged);
    expect(
      STEP_UP_ROUTES['POST /api/webhooks/[id]/deliveries/[deliveryId]/redeliver'],
    ).toBe(STEP_UP_WINDOWS.privileged);
    expect(STEP_UP_ROUTES['POST /api/sso/providers']).toBe(STEP_UP_WINDOWS.privileged);
    expect(STEP_UP_ROUTES['DELETE /api/retention/holds/[id]']).toBe(
      STEP_UP_WINDOWS.destructive,
    );
    expect(STEP_UP_ROUTES['DELETE /api/retention/policies/[id]']).toBe(
      STEP_UP_WINDOWS.destructive,
    );
    expect(STEP_UP_ROUTES['POST /api/break-glass/[id]/deny']).toBe(
      STEP_UP_WINDOWS.privileged,
    );
    expect(STEP_UP_ROUTES['POST /api/break-glass/[id]/revoke']).toBe(
      STEP_UP_WINDOWS.privileged,
    );
    for (const route of [
      'POST /api/break-glass',
      'POST /api/break-glass/[id]/activate',
      'POST /api/break-glass/[id]/approve',
      'POST /api/break-glass/[id]/review',
    ] as const) {
      expect(STEP_UP_ROUTES[route]).toBe(STEP_UP_WINDOWS.privileged);
    }
    expect(STEP_UP_WINDOWS.privileged).toBe(5 * 60);
    expect(STEP_UP_WINDOWS.sensitiveAction).toBe(10 * 60);
    expect(STEP_UP_WINDOWS.destructive).toBe(15 * 60);
  });

  it('treats the exact window as fresh and anything older as stale', () => {
    const authenticatedAt = new Date(0);
    expect(isAuthenticationStale(authenticatedAt, 10, new Date(10_000))).toBe(false);
    expect(isAuthenticationStale(authenticatedAt, 10, new Date(10_001))).toBe(true);
    expect(isAuthenticationStale(new Date(Number.NaN), 10, new Date())).toBe(true);
  });

  it('returns the step-up code from the shared error body', async () => {
    expect(stepUpRequiredBody()).toEqual({
      error: 'Re-authentication required',
      code: STEP_UP_REQUIRED_CODE,
    });
    const response = errorResponse(new StepUpRequiredError(600));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject(stepUpRequiredBody());
  });
});

describe('staff session lifetime', () => {
  const created = new Date('2026-01-01T00:00:00.000Z');
  const idle = STAFF_IDLE_TIMEOUT_DEFAULT_SECONDS;

  it('expires idle time past the tenant window and keeps the boundary', () => {
    const activity = new Date('2026-01-01T00:10:00.000Z');
    const boundary = new Date(activity.getTime() + idle * 1000);
    expect(
      evaluateStaffSession(
        { createdAt: created, lastActivityAt: activity },
        boundary,
        idle,
      ).state,
    ).toBe('valid');
    expect(
      evaluateStaffSession(
        { createdAt: created, lastActivityAt: activity },
        new Date(boundary.getTime() + 1),
        idle,
      ),
    ).toEqual({ state: 'expired', reason: 'idle' });
  });

  it('expires twelve hours after creation even when recently active', () => {
    const now = new Date(created.getTime() + STAFF_SESSION_ABSOLUTE_SECONDS * 1000);
    expect(
      evaluateStaffSession({ createdAt: created, lastActivityAt: now }, now, idle).state,
    ).toBe('valid');
    const past = new Date(now.getTime() + 1);
    expect(
      evaluateStaffSession({ createdAt: created, lastActivityAt: past }, past, idle),
    ).toEqual({ state: 'expired', reason: 'absolute' });
  });

  it('touches activity only after sixty seconds and clamps expiry', () => {
    const activity = new Date(created.getTime() + 60_000);
    const quiet = evaluateStaffSession(
      { createdAt: created, lastActivityAt: activity },
      new Date(activity.getTime() + 59_000),
      idle,
    );
    expect(quiet).toMatchObject({ state: 'valid', touch: false });
    const due = evaluateStaffSession(
      { createdAt: created, lastActivityAt: activity },
      new Date(activity.getTime() + 60_000),
      idle,
    );
    expect(due.state).toBe('valid');
    if (due.state === 'valid') {
      expect(due.touch).toBe(true);
      expect(due.expiresAt.getTime()).toBe(
        Math.min(
          created.getTime() + STAFF_SESSION_ABSOLUTE_SECONDS * 1000,
          activity.getTime() + 60_000 + idle * 1000,
        ),
      );
    }
  });

  it('fails closed on a bad timestamp and clamps the configured timeout', () => {
    expect(
      evaluateStaffSession(
        { createdAt: new Date(Number.NaN), lastActivityAt: created },
        created,
        idle,
      ),
    ).toEqual({ state: 'expired', reason: 'absolute' });
    expect(resolveStaffIdleTimeoutSeconds(null)).toBe(STAFF_IDLE_TIMEOUT_DEFAULT_SECONDS);
    expect(resolveStaffIdleTimeoutSeconds(10)).toBe(STAFF_IDLE_TIMEOUT_MIN_SECONDS);
    expect(resolveStaffIdleTimeoutSeconds(99_999)).toBe(STAFF_IDLE_TIMEOUT_MAX_SECONDS);
    expect(resolveStaffIdleTimeoutSeconds(2_000)).toBe(2_000);
  });
});

describe('authenticator codes and step-up retry', () => {
  it('matches the RFC 4226 HOTP vector', () => {
    expect(hotp('12345678901234567890', 0, 6)).toBe('755224');
  });

  it('accepts the current and adjacent TOTP step only', () => {
    const secret = '12345678901234567890';
    const now = 1_700_000_000_000;
    const counter = Math.floor(now / 1000 / 30);
    expect(totpMatches(secret, hotp(secret, counter), now)).toBe(true);
    expect(totpMatches(secret, hotp(secret, counter - 1), now)).toBe(true);
    expect(totpMatches(secret, hotp(secret, counter + 2), now)).toBe(false);
    expect(totpMatches(secret, '00000', now)).toBe(false);
  });

  it('finds a backup code without stopping at the first miss', () => {
    expect(matchBackupCode(['aaaaa-bbbbb', 'ccccc-ddddd'], 'ccccc-ddddd')).toBe(1);
    expect(matchBackupCode(['aaaaa-bbbbb'], 'zzzzz-zzzzz')).toBe(-1);
  });

  it('seals a passkey context and rejects tamper or expiry', () => {
    const secret = 'test-secret-value-at-least-32-characters-long';
    const payload = { userId: 'user-1', organisationId: 'org-1', exp: 5_000 };
    const token = sealStepUpContext(payload, secret);
    expect(openStepUpContext(token, secret, 5_000)).toEqual(payload);
    expect(openStepUpContext(token, secret, 5_001)).toBeNull();
    expect(openStepUpContext(`${token}x`, secret, 1)).toBeNull();
    const [body, sig] = token.split('.');
    expect(openStepUpContext(`${body}e.${sig}`, secret, 1)).toBeNull();
  });

  it('retries the action after re-authentication and keeps the first response on cancel', async () => {
    let calls = 0;
    const action = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ code: 'STEP_UP_REQUIRED' }, { status: 401 });
      }
      return Response.json({ ok: true });
    };
    const retried = await withStepUp(action, async () => true);
    expect(calls).toBe(2);
    await expect(retried.json()).resolves.toEqual({ ok: true });

    calls = 0;
    const cancelled = await withStepUp(action, async () => false);
    expect(calls).toBe(1);
    expect(cancelled.status).toBe(401);
    expect(await responseNeedsStepUp(cancelled)).toBe(true);
  });
});
