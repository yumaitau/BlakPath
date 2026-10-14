import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { scopeFor } from '@/db/tenant-db';
import { organisationSettings, sessions } from '@/db/schema';
import { logger } from '@/lib/observability/logger';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import type { TenantContext } from '@/lib/tenancy/context';
import {
  evaluateStaffSession,
  resolveStaffIdleTimeoutSeconds,
  STAFF_IDLE_TIMEOUT_DEFAULT_SECONDS,
  STAFF_IDLE_TIMEOUT_MAX_SECONDS,
  STAFF_IDLE_TIMEOUT_MIN_SECONDS,
} from './staff-session-policy';

/**
 * Load and enforce the per-tenant staff idle timeout.
 *
 * A missing settings row, or a database that has not yet added the column,
 * uses the 45-minute default. Enforcement deletes an expired session row and
 * returns `expired` even when that delete fails, so the caller still treats
 * the person as signed out.
 */

export async function readStaffIdleTimeoutSeconds(
  organisationId: string,
): Promise<number> {
  try {
    const rows = await scopeFor(organisationId)
      .db.select({ seconds: organisationSettings.staffIdleTimeoutSeconds })
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, organisationId))
      .limit(1);
    return resolveStaffIdleTimeoutSeconds(rows[0]?.seconds);
  } catch (error) {
    logger.warn({ err: error }, 'staff idle timeout unavailable; using default');
    return STAFF_IDLE_TIMEOUT_DEFAULT_SECONDS;
  }
}

export async function enforceStaffSessionLifetime(input: {
  sessionId: string;
  organisationId: string;
  createdAt: Date;
  lastActivityAt: Date;
  now?: Date;
}): Promise<'valid' | 'expired'> {
  const idle = await readStaffIdleTimeoutSeconds(input.organisationId);
  const decision = evaluateStaffSession(
    { createdAt: input.createdAt, lastActivityAt: input.lastActivityAt },
    input.now ?? new Date(),
    idle,
  );
  if (decision.state === 'expired') {
    await db
      .delete(sessions)
      .where(eq(sessions.id, input.sessionId))
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'failed to delete expired staff session');
      });
    return 'expired';
  }
  if (decision.touch) {
    await db
      .update(sessions)
      .set({ expiresAt: decision.expiresAt })
      .where(eq(sessions.id, input.sessionId))
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'failed to refresh staff session expiry');
      });
  }
  return 'valid';
}

export async function getOrganisationSessionPolicy(
  ctx: TenantContext,
): Promise<{ idleTimeoutSeconds: number }> {
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const idleTimeoutSeconds = await readStaffIdleTimeoutSeconds(ctx.organisationId);
  return { idleTimeoutSeconds };
}

export async function setOrganisationSessionPolicy(
  ctx: TenantContext,
  idleTimeoutSeconds: number,
): Promise<{ idleTimeoutSeconds: number }> {
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  if (
    !Number.isInteger(idleTimeoutSeconds) ||
    idleTimeoutSeconds < STAFF_IDLE_TIMEOUT_MIN_SECONDS ||
    idleTimeoutSeconds > STAFF_IDLE_TIMEOUT_MAX_SECONDS
  ) {
    throw new Error('Staff idle timeout must be between 30 and 60 minutes.');
  }
  await scopeFor(ctx.organisationId)
    .db.insert(organisationSettings)
    .values({
      organisationId: ctx.organisationId,
      staffIdleTimeoutSeconds: idleTimeoutSeconds,
    })
    .onConflictDoUpdate({
      target: organisationSettings.organisationId,
      set: { staffIdleTimeoutSeconds: idleTimeoutSeconds },
    });
  return { idleTimeoutSeconds };
}
