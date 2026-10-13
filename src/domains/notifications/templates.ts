/**
 * Pure notification email templates.
 *
 * Kept side-effect free and free of any DB/env imports so it can be unit tested
 * in isolation and composed by the worker without a second DB round-trip. The
 * link is always a plain, permission-checked app URL — never a bearer secret.
 *
 * Email copies are deliberately GENERIC: a notification's title and body are
 * free text that may carry case details (names, application context, event
 * titles and locations), and email leaves our control once sent. The detail
 * stays in the in-app notification; the email only says where to look.
 */
export function renderNotificationEmail(input: {
  name: string;
  /** Notification type, e.g. 'calendar-reminder'. Selects the generic line. */
  type: string;
  appUrl: string;
  /** Pre-formatted local start time, for calendar reminders only. */
  startsAt?: string | null;
}): { subject: string; text: string } {
  if (input.type === 'calendar-reminder') {
    return {
      subject: 'Reminder: you have an upcoming event in BlakPath',
      text: [
        `Hi ${input.name},`,
        '',
        input.startsAt
          ? `You have a calendar event starting ${input.startsAt}.`
          : 'You have a calendar event coming up.',
        '',
        'Sign in to see the details:',
        input.appUrl,
        '',
        'BlakPath',
      ].join('\n'),
    };
  }
  return {
    subject: 'You have a new notification in BlakPath',
    text: [
      `Hi ${input.name},`,
      '',
      'You have a new notification in BlakPath.',
      '',
      'Sign in to view it:',
      input.appUrl,
      '',
      'BlakPath',
    ].join('\n'),
  };
}
