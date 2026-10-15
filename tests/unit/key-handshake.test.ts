import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KEY_HANDSHAKE_NEGATIVE_ORG_ID,
  runKeyHandshake,
  withLocalKeyPolicy,
} from '@/lib/encryption/key-handshake';
import { LocalKeyProvider } from '@/lib/encryption/local-provider';

const ARN =
  'arn:aws:kms:ap-southeast-2:222222222222:key/abcdefab-1234-4678-9abc-def012345678';
const ORG = '018f0000-0000-7000-8000-000000000002';

describe('key handshake', () => {
  it('passes when the policy binds org_id and the wrong context is refused', async () => {
    const provider = withLocalKeyPolicy(new LocalKeyProvider(randomBytes(32)), ORG);
    const result = await runKeyHandshake(provider, { keyArn: ARN, orgId: ORG });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canaryCiphertext.length).toBeGreaterThan(16);
      result.canaryCiphertext.fill(0);
    }
  });

  it('fails when a foreign org_id can still generate a data key', async () => {
    const result = await runKeyHandshake(new LocalKeyProvider(randomBytes(32)), {
      keyArn: ARN,
      orgId: ORG,
    });
    expect(result).toEqual({ ok: false, code: 'wrong_context_allowed' });
  });

  it('refuses the negative sentinel as the organisation under test', async () => {
    const provider = withLocalKeyPolicy(
      new LocalKeyProvider(randomBytes(32)),
      KEY_HANDSHAKE_NEGATIVE_ORG_ID,
    );
    const result = await runKeyHandshake(provider, {
      keyArn: ARN,
      orgId: KEY_HANDSHAKE_NEGATIVE_ORG_ID,
    });
    expect(result).toEqual({ ok: false, code: 'unexpected_error' });
  });
});
