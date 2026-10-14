import { createAuthMiddleware } from 'better-auth/api';
import { recordAudit, recordPlatformAudit } from '@/domains/audit';
import type { AuditAction, ResourceType } from '@/domains/audit';
import { logger } from '@/lib/observability/logger';

/**
 * Audit attribution for a staff second-factor denial. MFA is an account fact,
 * but a denial while entering a tenant is recorded on that tenant's chain.
 * A null organisation id records the event on the platform chain.
 */
export interface StaffMfaAuditContext {
  readonly organisationId: string | null;
  readonly sessionId?: string | null;
  readonly actingRole?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId?: string | null;
  readonly requestId?: string | null;
}

const pendingTotpEnrolment = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function readSuccessJson(
  returned: unknown,
): Promise<Record<string, unknown> | null> {
  if (returned instanceof Response) {
    if (!returned.ok) return null;
    try {
      const body: unknown = await returned.clone().json();
      return isRecord(body) ? body : null;
    } catch {
      return null;
    }
  }
  if (!isRecord(returned)) return null;
  if (typeof returned.statusCode === 'number' && returned.statusCode >= 400) return null;
  return returned;
}

async function recordMfaEnrolment(input: {
  userId: string;
  action: Extract<AuditAction, 'mfa.enrolled' | 'mfa.passkey_registered'>;
  resourceType: Extract<ResourceType, 'mfa_method' | 'passkey'>;
  resourceId: string | null;
  method: 'totp' | 'passkey';
  sessionId: string | null;
}): Promise<void> {
  try {
    await recordPlatformAudit({
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      result: 'success',
      actorUserId: input.userId,
      sessionId: input.sessionId,
      after: { data: { method: input.method }, allow: ['method'] },
    });
  } catch (err) {
    logger.error({ err }, 'second-factor enrolment was not audited');
  }
}

/**
 * Record that a staff account was refused because it has no verified second
 * factor. Audit failure must not turn the refusal into a server error.
 */
export async function recordStaffMfaDenial(
  userId: string,
  audit: StaffMfaAuditContext,
): Promise<void> {
  const event = {
    action: 'mfa.access_denied' as const,
    resourceType: 'mfa_method' as const,
    resourceId: userId,
    result: 'denied' as const,
    reason: 'no_second_factor',
    actorUserId: userId,
    actingRole: audit.actingRole ?? null,
    sessionId: audit.sessionId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    correlationId: audit.correlationId ?? null,
    requestId: audit.requestId ?? null,
  };
  try {
    if (audit.organisationId) {
      await recordAudit({ ...event, organisationId: audit.organisationId });
    } else {
      await recordPlatformAudit(event);
    }
  } catch (err) {
    logger.error({ err }, 'staff second-factor denial was not audited');
  }
}

/**
 * Database hooks for completed TOTP enrolment. Better Auth sets
 * `twoFactorEnabled` only after the user confirms a code, which is the
 * enrolment event. The before/after pair sees that patch and nothing else.
 */
export const staffMfaDatabaseHooks = {
  user: {
    update: {
      async before(user: Record<string, unknown>, context: object | null): Promise<void> {
        if (user.twoFactorEnabled === true && context) {
          pendingTotpEnrolment.add(context);
        }
      },
      async after(user: Record<string, unknown>, context: object | null): Promise<void> {
        if (!context || !pendingTotpEnrolment.delete(context)) return;
        const userId = stringField(user, 'id');
        if (!userId) return;
        await recordMfaEnrolment({
          userId,
          action: 'mfa.enrolled',
          resourceType: 'mfa_method',
          resourceId: userId,
          method: 'totp',
          sessionId: sessionIdFrom(context),
        });
      },
    },
  },
};

function returnedBody(context: object): unknown {
  return 'returned' in context ? context.returned : undefined;
}

function sessionIdFrom(context: object): string | null {
  if (!('context' in context) || !isRecord(context.context)) return null;
  const session = context.context.session;
  if (!isRecord(session) || !isRecord(session.session)) return null;
  return stringField(session.session, 'id');
}

/** After a passkey registration succeeds, record `mfa.passkey_registered`. */
export async function recordPasskeyRegistration(ctx: {
  path: string;
  context: object & {
    session?: { user?: { id?: string }; session?: { id?: string } };
  };
}): Promise<void> {
  if (ctx.path !== '/passkey/verify-registration') return;
  const created = await readSuccessJson(returnedBody(ctx.context));
  if (!created) return;
  const userId = stringField(created, 'userId') ?? ctx.context.session?.user?.id ?? null;
  if (!userId) return;
  await recordMfaEnrolment({
    userId,
    action: 'mfa.passkey_registered',
    resourceType: 'passkey',
    resourceId: stringField(created, 'id'),
    method: 'passkey',
    sessionId: ctx.context.session?.session?.id ?? null,
  });
}

export const auditPasskeyRegistration = createAuthMiddleware(async (ctx) => {
  await recordPasskeyRegistration(ctx);
});
