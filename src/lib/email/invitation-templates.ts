/**
 * Pure invitation email copy. The worker fills these from tenant rows.
 * Nothing here is written to a queue.
 */

export function renderFormInvitationEmail(input: {
  recipientName: string | null;
  formTitle: string;
  completionUrl: string;
}): { subject: string; text: string } {
  const name = input.recipientName ?? 'there';
  return {
    subject: 'You have been invited to complete a form in BlakPath',
    text: [
      `Hi ${name},`,
      '',
      `You have been invited to complete the form "${input.formTitle}".`,
      'Open the link below to begin. It will expire after a while.',
      '',
      input.completionUrl,
      '',
      'BlakPath',
    ].join('\n'),
  };
}

export function renderMembershipInvitationEmail(input: {
  organisationName: string;
  roleName: string;
  joinUrl: string;
}): { subject: string; text: string } {
  return {
    subject: `Invitation to join ${input.organisationName} in BlakPath`,
    text: [
      `You have been invited to join ${input.organisationName} as ${input.roleName}.`,
      '',
      'Sign in with this email address and review the invitation:',
      input.joinUrl,
      '',
      'The link expires in 14 days. If you were not expecting this invitation, you can ignore it.',
      '',
      'BlakPath',
    ].join('\n'),
  };
}
