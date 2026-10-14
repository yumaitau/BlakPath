import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { scopeFor } from '@/db/tenant-db';
import {
  membershipRoles,
  memberships,
  passkeys,
  roles,
  twoFactors,
  users,
} from '@/db/schema';
import { recordStaffMfaDenial, type StaffMfaAuditContext } from '@/lib/auth/mfa-audit';

/**
 * Staff multi-factor authentication policy.
 *
 * SECURITY INTENT
 * ---------------
 * Any account that can act on behalf of an authorised organisation — reviewing
 * applications, handling evidence, issuing outcomes — is "staff" and MUST hold
 * a second factor. A single stolen password must never be enough to reach
 * sensitive cultural and personal information. The preferred factor is a
 * phishing-resistant WebAuthn passkey; TOTP with recovery codes is accepted as
 * an alternative.
 *
 * This module is split into a PURE decision function (easily unit-tested, no
 * I/O) and a thin async guard that gathers the enrolment facts from the
 * database. Keeping the decision pure means the rule is auditable in one place
 * and cannot drift between call sites.
 */

/** The MFA enrolment facts a decision is made from. */
export interface MfaEnrolment {
  /** The user holds at least one registered WebAuthn passkey. */
  hasPasskey: boolean;
  /** The user has a TOTP factor that has been confirmed with a code. */
  hasTotp: boolean;
}

/**
 * Where a staff member who still owes a second factor is sent. This route sits
 * outside the staff shell so the redirect cannot loop.
 */
export const STAFF_MFA_ENROL_PATH = '/mfa/enrol';

/**
 * Roles that use the applicant flow. They are not staff and are not forced to
 * enrol. Any other role, or a membership with no role yet, is staff.
 */
const APPLICANT_ROLE_SLUGS = new Set(['applicant', 'applicant-representative']);

/**
 * True when this membership must hold a verified second factor before tenant
 * data is served. Applicant-only memberships are the documented exception.
 */
export function staffMfaApplies(roleSlugs: readonly string[]): boolean {
  if (roleSlugs.length === 0) return true;
  return roleSlugs.some((slug) => !APPLICANT_ROLE_SLUGS.has(slug));
}

/** The outcome of evaluating the staff MFA policy for an account. */
export interface StaffMfaDecision {
  /** True when the account satisfies the staff MFA requirement. */
  satisfied: boolean;
  /** A stable, non-sensitive reason code for auditing and UX messaging. */
  reason: 'ok' | 'no_second_factor';
  enrolment: MfaEnrolment;
}

/**
 * PURE policy: does this enrolment satisfy the staff MFA requirement?
 *
 * The requirement is "at least one second factor". It is intentionally an OR:
 * a passkey OR TOTP is sufficient. This function performs no I/O and makes no
 * authority decision beyond MFA presence.
 */
export function evaluateStaffMfa(enrolment: MfaEnrolment): StaffMfaDecision {
  const satisfied = enrolment.hasPasskey || enrolment.hasTotp;
  return {
    satisfied,
    reason: satisfied ? 'ok' : 'no_second_factor',
    enrolment,
  };
}

/**
 * Raised when a staff account attempts a protected action without an enrolled
 * second factor. Callers translate this into an "enrol MFA to continue" flow.
 * It carries no secret and no user-identifying detail beyond the id it was
 * checked for.
 */
export class StaffMfaRequiredError extends Error {
  readonly code = 'STAFF_MFA_REQUIRED';
  readonly status = 403;
  readonly userId: string;
  constructor(userId: string) {
    super(
      'Staff accounts must enrol a passkey or an authenticator app before continuing.',
    );
    this.name = 'StaffMfaRequiredError';
    this.userId = userId;
  }
}

/**
 * Gathers the MFA enrolment facts for a user directly from the auth tables.
 * Read-only; touches only platform auth tables (no tenant data).
 */
export async function getMfaEnrolment(userId: string): Promise<MfaEnrolment> {
  const [passkeyRow, totpRow] = await Promise.all([
    db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .limit(1),
    db
      .select({ id: twoFactors.id })
      .from(twoFactors)
      .where(and(eq(twoFactors.userId, userId), eq(twoFactors.verified, true)))
      .limit(1),
  ]);
  return {
    hasPasskey: passkeyRow.length > 0,
    hasTotp: totpRow.length > 0,
  };
}

/**
 * Evaluates the staff MFA policy for a user against live enrolment state.
 * Returns the full decision so callers can log the reason without re-querying.
 */
export async function checkStaffMfa(userId: string): Promise<StaffMfaDecision> {
  const enrolment = await getMfaEnrolment(userId);
  return evaluateStaffMfa(enrolment);
}

/**
 * Guard: enforces the staff MFA requirement, throwing
 * {@link StaffMfaRequiredError} when unmet. Call before granting a staff
 * account access to any protected surface. Returns the decision on success so
 * the caller may audit-log the satisfied enrolment.
 */
export async function requireStaffMfa(
  userId: string,
  audit?: StaffMfaAuditContext,
): Promise<StaffMfaDecision> {
  const decision = await checkStaffMfa(userId);
  if (!decision.satisfied) {
    if (audit) await recordStaffMfaDenial(userId, audit);
    throw new StaffMfaRequiredError(userId);
  }
  return decision;
}

async function userIsPlatformOperator(userId: string): Promise<boolean> {
  const rows = await db
    .select({ isPlatformOperator: users.isPlatformOperator })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.isPlatformOperator === true;
}

/**
 * Staff, and every platform operator, must satisfy the second-factor policy.
 * Applicant-only memberships do not, unless the account is also an operator.
 */
export async function tenantActorRequiresStaffMfa(
  userId: string,
  roleSlugs: readonly string[],
): Promise<boolean> {
  if (staffMfaApplies(roleSlugs)) return true;
  return userIsPlatformOperator(userId);
}

/** Role slugs on the user's active membership of one organisation. */
export async function membershipRequiresStaffMfa(
  userId: string,
  organisationId: string,
): Promise<boolean> {
  const roleRows = await scopeFor(organisationId)
    .db.select({ slug: roles.slug })
    .from(membershipRoles)
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .innerJoin(memberships, eq(membershipRoles.membershipId, memberships.id))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organisationId, organisationId),
        eq(memberships.status, 'active'),
      ),
    );
  return tenantActorRequiresStaffMfa(
    userId,
    roleRows.map((row) => row.slug),
  );
}
