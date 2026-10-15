import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { z } from 'zod';
import { recordPlatformAudit } from '@/domains/audit/service';
import { logger } from '@/lib/observability/logger';
import { enforceStaffSessionLifetime } from './staff-session';
import { matchBackupCode, totpMatches } from './totp';

type AuthEndpointContext = Parameters<typeof setSessionCookie>[0];

/**
 * Password (and authenticator, when enrolled) re-authentication.
 *
 * This does not call email sign-in. That path deletes the current session
 * cookie when a second factor is enrolled. Factors are checked first; the
 * existing session is removed only after a new one is minted and its cookie
 * is set.
 *
 * A passkey uses the browser WebAuthn flow plus the prepare/complete routes,
 * which restore the active organisation for the same user.
 */

const bodySchema = z.object({
  password: z.string().min(1).max(256),
  totpCode: z.string().max(12).optional(),
  backupCode: z.string().max(32).optional(),
});

interface AuthSession {
  session: {
    id: string;
    token: string;
    createdAt: Date | string;
    updatedAt?: Date | string;
    activeOrganisationId?: string | null;
  };
  user: { id: string };
}

interface CredentialAccount {
  providerId?: string;
  password?: string | null;
}

interface TwoFactorRow {
  id: string;
  secret: string;
  backupCodes: string;
}

interface SessionAdapter {
  createSession: (
    userId: string,
    dontRememberMe?: boolean,
    override?: Record<string, unknown>,
    overrideAll?: boolean,
  ) => Promise<{ id: string; token: string } | null>;
  deleteSession: (token: string) => Promise<void>;
  findAccounts: (userId: string) => Promise<CredentialAccount[]>;
}

interface FactorAdapter {
  findOne: (input: {
    model: string;
    where: Array<{ field: string; value: string }>;
  }) => Promise<TwoFactorRow | null>;
  incrementOne: (input: {
    model: string;
    where: Array<{ field: string; value: string }>;
    increment: Record<string, number>;
    set: { backupCodes: string };
  }) => Promise<unknown>;
}

function asDate(value: Date | string | undefined, fallback: Date): Date {
  if (value == null) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

async function readBackupCodes(
  stored: string,
  key: Parameters<typeof symmetricDecrypt>[0]['key'],
): Promise<string[] | null> {
  const candidates: string[] = [];
  try {
    candidates.push(await symmetricDecrypt({ key, data: stored }));
  } catch {
    candidates.push(stored);
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.every((code) => typeof code === 'string')) {
        return parsed;
      }
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

async function consumeBackupCode(
  adapter: FactorAdapter,
  row: TwoFactorRow,
  provided: string,
  key: Parameters<typeof symmetricEncrypt>[0]['key'],
): Promise<boolean> {
  const codes = await readBackupCodes(row.backupCodes, key);
  if (!codes) return false;
  const index = matchBackupCode(codes, provided.trim());
  if (index < 0) return false;
  const remaining = codes.filter((_, i) => i !== index);
  const backupCodes = await symmetricEncrypt({
    key,
    data: JSON.stringify(remaining),
  });
  const updated = await adapter.incrementOne({
    model: 'twoFactor',
    where: [
      { field: 'id', value: row.id },
      { field: 'backupCodes', value: row.backupCodes },
    ],
    increment: {},
    set: { backupCodes },
  });
  return Boolean(updated);
}

function failed(code: 'REAUTH_FAILED' | 'TOTP_REQUIRED' | 'SESSION_EXPIRED') {
  return { ok: false as const, code };
}

export const stepUp = () => {
  return {
    id: 'step-up',
    endpoints: {
      stepUp: createAuthEndpoint(
        '/step-up',
        {
          method: 'POST',
          body: bodySchema,
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const current = ctx.context.session as AuthSession | null;
          if (!current?.user?.id || !current.session?.token) {
            throw APIError.from('UNAUTHORIZED', {
              message: 'Unauthorized',
              code: 'UNAUTHORIZED',
            });
          }

          const organisationId = current.session.activeOrganisationId ?? null;
          if (organisationId) {
            const createdAt = asDate(current.session.createdAt, new Date(Number.NaN));
            const lifetime = await enforceStaffSessionLifetime({
              sessionId: current.session.id,
              organisationId,
              createdAt,
              lastActivityAt: asDate(current.session.updatedAt, createdAt),
            });
            if (lifetime === 'expired') {
              deleteSessionCookie(ctx as AuthEndpointContext);
              return ctx.json(failed('SESSION_EXPIRED'), { status: 401 });
            }
          }

          const accounts = ctx.context.internalAdapter as unknown as SessionAdapter;
          const found = await accounts.findAccounts(current.user.id);
          const credential = found.find((account) => account.providerId === 'credential');
          const passwordApi = ctx.context.password;
          let passwordOk = false;
          try {
            if (!credential?.password) {
              await passwordApi.hash(ctx.body.password);
            } else {
              passwordOk = await passwordApi.verify({
                hash: credential.password,
                password: ctx.body.password,
              });
            }
          } catch {
            passwordOk = false;
          }
          if (!passwordOk) {
            await audit(current, 'failure');
            return ctx.json(failed('REAUTH_FAILED'), { status: 401 });
          }

          const factors = ctx.context.adapter as unknown as FactorAdapter;
          const twoFactor = await factors.findOne({
            model: 'twoFactor',
            where: [{ field: 'userId', value: current.user.id }],
          });
          if (twoFactor) {
            const totpCode = ctx.body.totpCode?.trim();
            const backupCode = ctx.body.backupCode?.trim();
            if (!totpCode && !backupCode) {
              return ctx.json(failed('TOTP_REQUIRED'), { status: 401 });
            }
            let factorOk = false;
            if (totpCode) {
              try {
                const secret = await symmetricDecrypt({
                  key: ctx.context.secretConfig,
                  data: twoFactor.secret,
                });
                factorOk = totpMatches(secret, totpCode);
              } catch {
                factorOk = false;
              }
            }
            if (!factorOk && backupCode) {
              factorOk = await consumeBackupCode(
                factors,
                twoFactor,
                backupCode,
                ctx.context.secretConfig,
              );
            }
            if (!factorOk) {
              await audit(current, 'failure');
              return ctx.json(failed('REAUTH_FAILED'), { status: 401 });
            }
          }

          const override: Record<string, unknown> = { lastAuthenticatedAt: new Date() };
          if (organisationId) override.activeOrganisationId = organisationId;
          let minted: { id: string; token: string } | null = null;
          try {
            minted = await accounts.createSession(current.user.id, false, override, true);
            if (!minted) throw new Error('session was not created');
            await setSessionCookie(
              ctx as AuthEndpointContext,
              {
                session: minted,
                user: current.user,
              } as Parameters<typeof setSessionCookie>[1],
              false,
            );
            await accounts.deleteSession(current.session.token);
          } catch (error) {
            ctx.context.logger.error('step-up session mint failed', error);
            if (minted?.token) {
              await accounts.deleteSession(minted.token).catch(() => undefined);
            }
            return ctx.json(failed('REAUTH_FAILED'), { status: 401 });
          }

          await audit(current, 'success', minted.id);
          return ctx.json({ ok: true });
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher(path: string) {
          return path === '/step-up';
        },
        window: 60,
        max: 5,
      },
    ],
  };
};

async function audit(
  current: AuthSession,
  result: 'success' | 'failure',
  sessionId?: string,
): Promise<void> {
  await recordPlatformAudit({
    action: result === 'success' ? 'auth.step_up_verified' : 'auth.step_up_failed',
    resourceType: 'session',
    resourceId: sessionId ?? current.session.id,
    result,
    actorUserId: current.user.id,
    sessionId: sessionId ?? current.session.id,
  }).catch((error: unknown) => {
    logger.error({ err: error }, 'step-up audit failed');
  });
}
