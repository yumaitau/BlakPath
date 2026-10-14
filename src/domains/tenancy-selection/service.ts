import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions } from '@/db/schema/auth';
import { resolveTenantContext } from '@/lib/tenancy/resolve';

/**
 * Setting the session's active organisation.
 *
 * This is the write half of organisation selection. The public API surface
 * hands us a `organisationId` that ultimately originates from the browser, so
 * it is UNTRUSTED until proven otherwise.
 */

/** Inputs for {@link setActiveOrganisation}. `organisationId` is untrusted. */
export interface SetActiveOrganisationInput {
  /** Authenticated user id (from the verified session — trusted). */
  userId: string;
  /** Session id whose active organisation is being set. */
  sessionId: string;
  /** UNTRUSTED: the organisation the user asked to make active. */
  organisationId: string;
}

/**
 * Record the user's chosen organisation as the session's active tenant.
 *
 * SECURITY: the chosen `organisationId` is verified against an ACTIVE
 * membership before it is written to the session — it is never trusted from the
 * client. We call {@link resolveTenantContext}, which queries the database for
 * an active membership binding this exact user to this exact organisation and
 * throws {@link TenantContextError} if none exists, and
 * {@link OrganisationUnavailableError} when the organisation is suspended or
 * closed. Only on success do we write the id. This means the session's advisory
 * `activeOrganisationId` can only ever name an organisation the user genuinely
 * belongs to and that is still operational.
 */
export async function setActiveOrganisation(
  input: SetActiveOrganisationInput,
): Promise<void> {
  const { userId, sessionId, organisationId } = input;

  // Verify active membership. Fresh trace ids per attempt for audit/tracing.
  // A throw here is the security gate: we do not write an unverified org id.
  await resolveTenantContext({
    userId,
    sessionId,
    organisationId,
    correlationId: globalThis.crypto.randomUUID(),
    requestId: globalThis.crypto.randomUUID(),
  });

  // Membership confirmed — persist the advisory active organisation.
  await db
    .update(sessions)
    .set({ activeOrganisationId: organisationId })
    .where(eq(sessions.id, sessionId));
}
