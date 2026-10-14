/**
 * Operator-facing copy for the first organisation administrator invitation.
 * The join URL is delivered by email only. Summaries printed by the CLI must
 * not include it.
 */

const INVITATION_LIFETIME_DAYS = 14;

export function firstAdminInvitationMessage(input: {
  organisationName: string;
  joinUrl: string;
}): { subject: string; text: string } {
  return {
    subject: `Invitation to administer ${input.organisationName} in BlakPath`,
    text: [
      `You have been invited to administer ${input.organisationName} in BlakPath.`,
      '',
      `Create your account from this link. It expires in ${INVITATION_LIFETIME_DAYS} days:`,
      input.joinUrl,
      '',
      'Before the organisation opens, enrol a passkey or an authenticator app. A password alone is not enough.',
      '',
      'If you were not expecting this invitation, you can ignore it.',
      '',
      'BlakPath',
    ].join('\n'),
  };
}

/** stdout for a successful invite. No bearer link and no credential. */
export function firstAdminInviteSummary(input: {
  organisationId: string;
  invitationId: string;
  email: string;
  slug: string;
}): string {
  return [
    '[invite-first-admin] invitation emailed',
    `  organisation: ${input.slug} (${input.organisationId})`,
    `  invitation: ${input.invitationId}`,
    `  email: ${input.email}`,
    '  role: organisation-admin',
    '  access: blocked until a passkey or authenticator is enrolled',
  ].join('\n');
}
