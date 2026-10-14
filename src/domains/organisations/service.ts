import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organisations } from '@/db/schema';
import { recordPlatformAudit } from '@/domains/audit/service';
import {
  keyAllowsActivation,
  OrganisationActivationError,
} from '@/domains/organisation-keys/activation';
import { getOrganisationKey } from '@/domains/organisation-keys/service';
import { logger } from '@/lib/observability/logger';
import type { OrganisationStatus } from '@/lib/tenancy/organisation-status';

/**
 * Platform-operator changes to an organisation's lifecycle.
 *
 * Status changes are not tenant events. They are appended to the platform
 * audit chain (null organisation id) so a suspended tenant cannot alter or
 * hide the record of its own suspension.
 */

/** The organisation id does not match a row. */
export class OrganisationNotFoundError extends Error {
  readonly code = 'ORGANISATION_NOT_FOUND';
  readonly status = 404;
  constructor() {
    super('Organisation not found.');
    this.name = 'OrganisationNotFoundError';
  }
}

export interface SetOrganisationStatusInput {
  readonly organisationId: string;
  readonly status: OrganisationStatus;
  readonly actorUserId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly requestId: string;
  readonly reason?: string | undefined;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * Set an organisation's status and audit the change on the platform chain.
 *
 * A no-op (already at the requested status) writes nothing. A move to
 * `active` is refused unless the tenant key is active and validated. If the audit
 * append fails, the status is restored so a lifecycle change is never left
 * without a platform-chain record.
 */
export async function setOrganisationStatus(
  input: SetOrganisationStatusInput,
): Promise<{ id: string; status: OrganisationStatus }> {
  const [current] = await db
    .select({
      id: organisations.id,
      status: organisations.status,
      statusReason: organisations.statusReason,
    })
    .from(organisations)
    .where(eq(organisations.id, input.organisationId))
    .limit(1);
  if (!current) throw new OrganisationNotFoundError();
  if (current.status === input.status) {
    return { id: current.id, status: current.status };
  }
  // Becoming `active` (first time or after suspension) needs the same
  // validated tenant key as tenant-admin activation. Operators cannot bypass it.
  if (
    input.status === 'active' &&
    !keyAllowsActivation(await getOrganisationKey(current.id))
  ) {
    throw new OrganisationActivationError();
  }

  await db
    .update(organisations)
    .set({ status: input.status, statusReason: input.reason ?? null })
    .where(eq(organisations.id, current.id));

  try {
    await recordPlatformAudit({
      action: 'organisation.status_changed',
      resourceType: 'organisation',
      resourceId: current.id,
      result: 'success',
      // Free text stays on organisations.status_reason; the trail records the code.
      reason: input.reason ? 'organisation.status_note' : null,
      actorUserId: input.actorUserId,
      actingRole: 'platform-operator',
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      requestId: input.requestId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      before: { data: { status: current.status }, allow: ['status'] },
      after: { data: { status: input.status }, allow: ['status'] },
    });
  } catch (error) {
    try {
      await db
        .update(organisations)
        .set({ status: current.status, statusReason: current.statusReason ?? null })
        .where(eq(organisations.id, current.id));
    } catch (rollbackError) {
      logger.error(
        { err: rollbackError, organisationId: current.id },
        'organisation status rollback failed after audit error',
      );
    }
    throw error;
  }

  return { id: current.id, status: input.status };
}
