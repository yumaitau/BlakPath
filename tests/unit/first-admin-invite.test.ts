import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  firstAdminInvitationMessage,
  firstAdminInviteSummary,
} from '@/domains/memberships/first-admin-message';

describe('first administrator invitation', () => {
  it('is not an HTTP route', () => {
    expect(existsSync(resolve('src/app/api/admin/pilot-bootstrap/route.ts'))).toBe(false);
  });

  it('tells the invitee to enrol a second factor and keeps the link in the email', () => {
    const message = firstAdminInvitationMessage({
      organisationName: 'Example Council',
      joinUrl: 'https://blakpath.example.org/join/invite-token',
    });
    expect(message.text).toContain('passkey or an authenticator app');
    expect(message.text).toContain('https://blakpath.example.org/join/invite-token');

    const summary = firstAdminInviteSummary({
      organisationId: 'org',
      invitationId: 'inv',
      email: 'admin@example.org',
      slug: 'example-council',
    });
    expect(summary).not.toContain('invite-token');
    expect(summary).not.toContain('/join/');
    expect(summary.toLowerCase()).not.toContain('password');
  });
});
