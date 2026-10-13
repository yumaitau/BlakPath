import { describe, expect, it } from 'vitest';
import { assertTenantJob } from '@/lib/queues';

describe('tenant job payloads', () => {
  it('accepts ids and a backfill cursor', () => {
    expect(
      assertTenantJob({
        organisationId: 'org',
        correlationId: 'corr',
        messageId: 'msg',
        cursor: 'applications:abc',
      }),
    ).toEqual({
      organisationId: 'org',
      correlationId: 'corr',
      messageId: 'msg',
      cursor: 'applications:abc',
    });
  });

  it('rejects field contents', () => {
    expect(() =>
      assertTenantJob({
        organisationId: 'org',
        correlationId: 'corr',
        subject: 'Invitation',
        text: 'body',
      } as never),
    ).toThrow(/not an id/);
  });
});
