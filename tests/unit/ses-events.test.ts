import { describe, expect, it } from 'vitest';
import { parseSesEvent } from '@/lib/email/ses-events';

describe('parseSesEvent', () => {
  it('reads identity notifications that use notificationType', () => {
    expect(
      parseSesEvent({
        notificationType: 'Bounce',
        mail: { messageId: 'msg-1' },
        bounce: { bouncedRecipients: [{ emailAddress: 'a@example.org' }] },
      }),
    ).toEqual({
      status: 'actionable',
      targets: [{ address: 'a@example.org', kind: 'bounce', sourceMessageId: 'msg-1' }],
    });
  });

  it('reads configuration-set events that use eventType', () => {
    expect(
      parseSesEvent({
        eventType: 'Complaint',
        complaint: { complainedRecipients: [{ emailAddress: 'b@example.org' }] },
      }),
    ).toEqual({
      status: 'actionable',
      targets: [{ address: 'b@example.org', kind: 'complaint' }],
    });
  });

  it('ignores delivery events and rejects a non-object', () => {
    expect(parseSesEvent({ eventType: 'Delivery' })).toEqual({ status: 'ignored' });
    expect(parseSesEvent(null)).toEqual({ status: 'invalid' });
    expect(parseSesEvent({ bounce: { bouncedRecipients: 'nope' } })).toEqual({
      status: 'invalid',
    });
  });
});
