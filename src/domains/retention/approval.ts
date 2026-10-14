import type { RetentionAction } from './rules';

/**
 * Two-person activation and purge gates — pure.
 *
 * Creating a policy does not turn it on. The person who activates it must be
 * someone else. A purge also needs a current records-manager sign-off whose
 * authority reference matches the policy. Permanent retention never becomes due.
 */

export function activationBlockReason(input: {
  creatorUserId: string | null;
  approverUserId: string;
  alreadyActive: boolean;
}): 'already_active' | 'same_actor' | null {
  if (input.alreadyActive) return 'already_active';
  if (!input.creatorUserId || input.creatorUserId === input.approverUserId) {
    return 'same_actor';
  }
  return null;
}

export interface SweepPolicyGate {
  readonly active: boolean;
  readonly action: RetentionAction;
  readonly retentionDays: number | null;
  readonly createdByUserId: string | null;
  readonly approvedByUserId: string | null;
  readonly disposalAuthorityRef: string | null;
  readonly disposalClass: string | null;
  readonly jurisdiction: string | null;
}

export interface AuthoritySignoffGate {
  readonly authorityReference: string;
  readonly permanent: boolean;
  readonly disposalClass: string;
  readonly jurisdiction: string;
  readonly minimumRetentionDays: number | null;
}

export type SweepBlockReason =
  | 'inactive'
  | 'not_approved'
  | 'same_actor'
  | 'permanent'
  | 'missing_authority'
  | 'no_signoff'
  | 'authority_mismatch'
  | 'class_permanent'
  | 'class_forbidden'
  | 'below_signed_minimum';

/** Two-person activation, and not a permanent keep. */
function approvalBlockReason(policy: SweepPolicyGate): SweepBlockReason | null {
  if (!policy.active) return 'inactive';
  if (!policy.approvedByUserId) return 'not_approved';
  if (!policy.createdByUserId || policy.approvedByUserId === policy.createdByUserId) {
    return 'same_actor';
  }
  if (policy.action === 'retain' || policy.retentionDays == null) return 'permanent';
  return null;
}

/** The policy's reference must match a current, non-permanent sign-off for its class. */
function authorityBlockReason(
  policy: SweepPolicyGate,
  signoff: AuthoritySignoffGate | null,
  destructionForbidden: boolean,
): SweepBlockReason | null {
  const reference = policy.disposalAuthorityRef?.trim() ?? '';
  if (reference.length === 0) return 'missing_authority';
  if (destructionForbidden) return 'class_forbidden';
  if (!signoff) return 'no_signoff';
  if (signoff.permanent) return 'class_permanent';
  if (
    signoff.authorityReference !== reference ||
    signoff.disposalClass !== policy.disposalClass ||
    signoff.jurisdiction !== policy.jurisdiction
  ) {
    return 'authority_mismatch';
  }
  if (
    signoff.minimumRetentionDays != null &&
    policy.retentionDays != null &&
    policy.retentionDays < signoff.minimumRetentionDays
  ) {
    return 'below_signed_minimum';
  }
  return null;
}

/**
 * Why the sweep must not act on this policy. `null` means it may.
 * Fail closed: a missing approver, a self-approval, a permanent keep, or a
 * purge without a matching signed authority all block.
 */
export function sweepBlockReason(
  policy: SweepPolicyGate,
  signoff: AuthoritySignoffGate | null,
  destructionForbidden: boolean,
): SweepBlockReason | null {
  const approval = approvalBlockReason(policy);
  if (approval) return approval;
  if (policy.action !== 'purge') return null;
  return authorityBlockReason(policy, signoff, destructionForbidden);
}

/**
 * True only when the policy is two-person approved and its disposal authority
 * reference matches a current records-manager sign-off for its class and
 * jurisdiction. Only then may the sweep dispose of an official record (decided
 * application, finalised decision, issued certificate), including the
 * hard-delete after grace. A bare, unverified reference never unlocks it.
 */
export function disposalAuthorityVerified(
  policy: SweepPolicyGate,
  signoff: AuthoritySignoffGate | null,
  destructionForbidden: boolean,
): boolean {
  return (
    approvalBlockReason(policy) === null &&
    authorityBlockReason(policy, signoff, destructionForbidden) === null
  );
}
