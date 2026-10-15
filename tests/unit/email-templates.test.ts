import { describe, expect, it } from 'vitest';
import { renderNotificationEmail } from '@/domains/notifications/templates';

/**
 * `renderNotificationEmail` is the one pure, side-effect-free template extracted
 * from the notification pipeline. It must always link back to the app (never a
 * bearer URL) and must stay GENERIC: notification titles/bodies are free text
 * that may carry case details, so the template does not even accept them.
 */
describe('renderNotificationEmail', () => {
  const appUrl = 'https://app.blakpath.test';

  it('renders a generic subject, greeting and app link', () => {
    const { subject, text } = renderNotificationEmail({
      name: 'Sam',
      type: 'evidence.infected',
      appUrl,
    });
    expect(subject).toBe('You have a new notification in BlakPath');
    expect(text).toContain('Hi Sam,');
    expect(text).toContain('You have a new notification in BlakPath.');
    expect(text).toContain(appUrl);
    expect(text).not.toContain('\n\n\n');
  });

  it('carries no case detail — only fixed copy, the name and the link', () => {
    const { subject, text } = renderNotificationEmail({
      name: 'Sam',
      type: 'form.response_submitted',
      appUrl,
    });
    const fixed = text.replace('Sam', '').replace(appUrl, '');
    expect(fixed).toBe(
      [
        'Hi ,',
        '',
        'You have a new notification in BlakPath.',
        '',
        'Sign in to view it:',
        '',
        '',
        'BlakPath',
      ].join('\n'),
    );
    expect(subject).not.toMatch(/form|response/i);
  });

  it('states the local start time for calendar reminders', () => {
    const { subject, text } = renderNotificationEmail({
      name: 'Sam',
      type: 'calendar-reminder',
      appUrl,
      startsAt: 'Thursday 15 October 2026 at 9:30 am AEDT',
    });
    expect(subject).toBe('Reminder: you have an upcoming event in BlakPath');
    expect(text).toContain(
      'You have a calendar event starting Thursday 15 October 2026 at 9:30 am AEDT.',
    );
    expect(text).toContain(appUrl);
  });

  it('falls back to a timeless reminder when the start is unknown', () => {
    const { text } = renderNotificationEmail({
      name: 'Sam',
      type: 'calendar-reminder',
      appUrl,
      startsAt: null,
    });
    expect(text).toContain('You have a calendar event coming up.');
  });

  it('never embeds a bearer token — only the plain app URL', () => {
    const { text } = renderNotificationEmail({
      name: 'Sam',
      type: 'anything',
      appUrl,
    });
    expect(text).not.toContain('token');
    expect(text.match(new RegExp(appUrl, 'g'))?.length).toBe(1);
  });
});
