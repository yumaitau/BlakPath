import { isApplicantOnlyRoleSet } from '@/lib/permissions/roles';

/** Where a successful sign-in lands before role routing. */
export const POST_SIGN_IN_PATH = '/home';

/**
 * Staff home or the applicant portal.
 *
 * An applicant-only membership never lands in the staff shell. Mixed roles
 * (someone who is both staff and an applicant) keep the staff home; they can
 * still open their own application from the portal.
 */
export function destinationForRoles(
  roleSlugs: readonly string[],
): '/portal' | '/dashboard' {
  return isApplicantOnlyRoleSet(roleSlugs) ? '/portal' : '/dashboard';
}

/**
 * Applicant-only actors may change only the application they are named on.
 * Staff roles keep the existing permission checks. A null applicant link is
 * not "own": the account has not been attached to that matter.
 */
export function applicantMayActOnCase(
  roleSlugs: readonly string[],
  actorUserId: string,
  applicantUserId: string | null,
): boolean {
  if (!isApplicantOnlyRoleSet(roleSlugs)) return true;
  return applicantUserId !== null && applicantUserId === actorUserId;
}
