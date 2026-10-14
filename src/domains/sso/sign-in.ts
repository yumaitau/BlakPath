import { and, eq, type SQL } from 'drizzle-orm';
import { platformDb } from '@/db/platform-db';
import { scopeFor } from '@/db/tenant-db';
import { memberships, organisationDomains, organisationSsoProviders } from '@/db/schema';
import { recordAudit } from '@/domains/audit/service';
import { auditReason } from '@/domains/audit/hash';

/**
 * Tenant-bound federated sign-in decisions.
 *
 * These run BEFORE a session exists, so they read the binding tables directly
 * (there is no tenant context yet) and never trust browser input beyond the
 * email domain used for routing. A binding is usable only when it is enabled,
 * its domain is verified for the SAME organisation, and its provider is
 * registered. Anything else is a denial: the caller returns one generic error
 * and the password/MFA path stays available.
 */

/** Stable, non-sensitive denial codes recorded in the audit trail. */
export type SsoDenialReason =
  | 'BINDING_DISABLED'
  | 'DOMAIN_UNVERIFIED'
  | 'PROVIDER_UNAVAILABLE'
  | 'VERIFICATION_FAILED'
  | 'EMAIL_DOMAIN_MISMATCH'
  | 'NO_ACCOUNT'
  | 'EMAIL_UNVERIFIED'
  | 'NO_ACTIVE_MEMBERSHIP'
  | 'MFA_REQUIRED';

export interface SsoBinding {
  id: string;
  organisationId: string;
  providerKey: string;
  issuer: string;
  clientId: string;
  domain: string;
}

export interface SsoBindingCandidate extends SsoBinding {
  enabled: boolean;
  domainVerified: boolean;
}

export type SsoBindingResolution =
  | { kind: 'ok'; binding: SsoBinding }
  | {
      kind: 'denied';
      organisationId: string;
      bindingId: string;
      providerKey: string;
      reason: SsoDenialReason;
    }
  | { kind: 'none' };

/** Lower-cased domain part of an email, or null when there is none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * PURE: pick the first usable binding, else explain why the first one is not
 * usable. No rows = SSO simply is not offered for that domain.
 */
export function selectSsoBinding(
  rows: readonly SsoBindingCandidate[],
  isRegistered: (providerKey: string) => boolean,
): SsoBindingResolution {
  const usable = rows.find(
    (row) => row.enabled && row.domainVerified && isRegistered(row.providerKey),
  );
  if (usable) {
    const { enabled: _enabled, domainVerified: _verified, ...binding } = usable;
    return { kind: 'ok', binding };
  }
  const first = rows[0];
  if (!first) return { kind: 'none' };
  const reason: SsoDenialReason = !first.domainVerified
    ? 'DOMAIN_UNVERIFIED'
    : !first.enabled
      ? 'BINDING_DISABLED'
      : 'PROVIDER_UNAVAILABLE';
  return {
    kind: 'denied',
    organisationId: first.organisationId,
    bindingId: first.id,
    providerKey: first.providerKey,
    reason,
  };
}

async function loadCandidates(where: SQL): Promise<SsoBindingCandidate[]> {
  const rows = await platformDb
    .select({
      id: organisationSsoProviders.id,
      organisationId: organisationSsoProviders.organisationId,
      providerKey: organisationSsoProviders.providerKey,
      issuer: organisationSsoProviders.issuer,
      clientId: organisationSsoProviders.clientId,
      domain: organisationSsoProviders.domain,
      enabled: organisationSsoProviders.enabled,
      verifiedDomainId: organisationDomains.id,
    })
    .from(organisationSsoProviders)
    // The verified domain must belong to the binding's own organisation.
    .leftJoin(
      organisationDomains,
      and(
        eq(organisationDomains.organisationId, organisationSsoProviders.organisationId),
        eq(organisationDomains.domain, organisationSsoProviders.domain),
        eq(organisationDomains.verified, true),
      ),
    )
    .where(where)
    .orderBy(organisationSsoProviders.createdAt);
  return rows.map(({ verifiedDomainId, ...row }) => ({
    ...row,
    domainVerified: verifiedDomainId !== null,
  }));
}

/** Route an email to its organisation's binding by (verified) email domain. */
export async function resolveSsoBindingForEmail(
  email: string,
  isRegistered: (providerKey: string) => boolean,
): Promise<SsoBindingResolution> {
  const domain = emailDomain(email);
  if (!domain) return { kind: 'none' };
  return selectSsoBinding(
    await loadCandidates(eq(organisationSsoProviders.domain, domain)),
    isRegistered,
  );
}

/** Re-check a binding at callback time; it may have been disabled mid-flow. */
export async function resolveSsoBindingById(
  bindingId: string,
  isRegistered: (providerKey: string) => boolean,
): Promise<SsoBindingResolution> {
  return selectSsoBinding(
    await loadCandidates(eq(organisationSsoProviders.id, bindingId)),
    isRegistered,
  );
}

/** True when the user holds an ACTIVE membership of exactly this organisation. */
export async function hasActiveMembership(
  userId: string,
  organisationId: string,
): Promise<boolean> {
  const rows = await scopeFor(organisationId)
    .db.select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organisationId, organisationId),
        eq(memberships.status, 'active'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const PROVIDER_REF = /^[A-Za-z0-9_-]{1,128}$/;

/** Audit a federated sign-in outcome on the organisation's chain. */
export async function recordSsoSignIn(input: {
  organisationId: string;
  providerKey: string;
  result: 'success' | 'denied';
  reason?: SsoDenialReason;
  userId?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await recordAudit({
    action: 'auth.sign_in',
    resourceType: 'session',
    resourceId: input.sessionId ?? null,
    result: input.result,
    // Coded as sso.<outcome>:<providerKey>. A provider key that is not
    // id-shaped is left out of the reason; it is still in `after`.
    reason: auditReason(
      input.reason ? `sso.${input.reason.toLowerCase()}` : 'sso.sign_in',
      PROVIDER_REF.test(input.providerKey) ? input.providerKey : null,
    ),
    after: { data: { providerKey: input.providerKey }, allow: ['providerKey'] },
    organisationId: input.organisationId,
    actorUserId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}
