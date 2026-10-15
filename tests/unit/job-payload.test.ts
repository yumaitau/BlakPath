import { describe, expect, it } from 'vitest';
import { assertTenantJob } from '@/lib/queues';

const organisationId = '11111111-1111-4111-8111-111111111111';

describe('tenant job payloads', () => {
  it('accepts ids and a backfill cursor', () => {
    expect(
      assertTenantJob({
        organisationId,
        correlationId: 'corr',
        messageId: 'msg',
        cursor: 'applications:abc',
      }),
    ).toEqual({
      organisationId,
      correlationId: 'corr',
      messageId: 'msg',
      cursor: 'applications:abc',
    });
  });

  it('rejects field contents', () => {
    expect(() =>
      assertTenantJob({
        organisationId,
        correlationId: 'corr',
        subject: 'Invitation',
        text: 'body',
      } as never),
    ).toThrow(/not an id/);
  });
});
