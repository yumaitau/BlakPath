import { afterEach, describe, expect, it } from 'vitest';
import { __resetEnvCache } from '@/lib/env';
import {
  assertWebhookDestination,
  assertWebhookDestinationForCreate,
  createWebhookLookup,
  isBlockedHostname,
  isBlockedIp,
  WebhookDestinationError,
  WebhookDnsError,
  webhookUrlIssue,
  type WebhookLookup,
} from '@/domains/webhooks/destination';
import { createEndpointSchema } from '@/domains/webhooks/schemas';

const PUBLIC_V4 = '1.1.1.1';
const PUBLIC_V6 = '2001:db8::5';

function invokeLookup(lookup: WebhookLookup, hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(hostname, {}, (err, address) => {
      if (err) {
        reject(err);
        return;
      }
      if (typeof address !== 'string') {
        reject(new Error('expected one address'));
        return;
      }
      resolve(address);
    });
  });
}

describe('webhook address policy', () => {
  it('blocks private, loopback, link-local, CGNAT and unique-local addresses', () => {
    const blocked = [
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '169.254.1.1',
      '100.64.0.1',
      '100.127.255.254',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fdff:ffff::1',
      'fc00::1',
      'fe80::1',
      '::ffff:a00:1',
      '::ffff:7f00:1',
      '::ffff:c0a8:1',
      '64:ff9b::a00:1',
    ];
    for (const address of blocked) expect(isBlockedIp(address), address).toBe(true);
  });

  it('allows global unicast addresses', () => {
    for (const address of [
      '1.1.1.1',
      '8.8.8.8',
      '11.0.0.1',
      '172.15.5.5',
      '172.32.0.1',
      '192.167.1.1',
      '192.169.1.1',
      '100.63.255.255',
      '100.128.0.1',
      '2001:db8::1',
    ]) {
      expect(isBlockedIp(address), address).toBe(false);
    }
  });

  it('blocks cluster, localhost and internal names', () => {
    expect(isBlockedHostname('hooks.app.svc.cluster.local')).toBe(true);
    expect(isBlockedHostname('A.B.SVC.CLUSTER.LOCAL.')).toBe(true);
    expect(isBlockedHostname('svc.cluster.local')).toBe(true);
    expect(isBlockedHostname('kubernetes.default.svc.cluster.local')).toBe(true);
    expect(isBlockedHostname('foo.cluster.local')).toBe(true);
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('db.localhost')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
    expect(isBlockedHostname('printer.local')).toBe(true);
    expect(isBlockedHostname('svc.cluster.local.example.com')).toBe(false);
    expect(isBlockedHostname('example.org')).toBe(false);
  });

  it('rejects blocked literals and names at the schema gate', () => {
    const rejected = [
      'http://example.org/hook',
      'https://10.1.2.3/hook',
      'https://172.16.5.5/hook',
      'https://192.168.0.5/hook',
      'https://127.0.0.1/hook',
      'https://127.1/hook',
      'https://2130706433/hook',
      'https://169.254.169.254/hook',
      'https://100.64.1.1/hook',
      'https://0/hook',
      'https://[::1]/hook',
      'https://[fd00::1]/hook',
      'https://[fc00::1]/hook',
      'https://[fe80::1]/hook',
      'https://[::ffff:10.0.0.1]/hook',
      'https://%31%30.0.0.1/hook',
      'https://hooks.app.svc.cluster.local/hook',
      'https://Hooks.App.Svc.Cluster.Local./hook',
      'https://localhost/hook',
      'https://metadata.google.internal/hook',
      'https://intranet/hook',
      'https://user:pass@example.org/hook',
    ];
    for (const url of rejected) {
      expect(webhookUrlIssue(url), url).not.toBeNull();
      expect(
        createEndpointSchema.safeParse({ url, events: ['decision.finalised'] }).success,
      ).toBe(false);
    }
  });

  it('accepts a public https URL before DNS', () => {
    expect(webhookUrlIssue('https://example.org/hook')).toBeNull();
    expect(webhookUrlIssue('https://1.1.1.1/hook')).toBeNull();
    expect(webhookUrlIssue('https://[2001:db8::1]/hook')).toBeNull();
    expect(
      createEndpointSchema.safeParse({
        url: 'https://example.org/hook',
        events: ['decision.finalised'],
      }).success,
    ).toBe(true);
  });
});

describe('webhook destination resolution', () => {
  const url = 'https://hooks.example/hook';

  it('rejects a name that resolves to any blocked address', async () => {
    const answers = [
      ['10.0.0.5'],
      ['172.16.0.9'],
      ['192.168.2.2'],
      ['127.0.0.2'],
      ['169.254.169.254'],
      ['100.64.8.8'],
      ['::1'],
      ['fd00::abcd'],
      [PUBLIC_V4, '10.1.1.1'],
      [PUBLIC_V6, 'fd12::1'],
      [],
    ];
    for (const addresses of answers) {
      await expect(
        assertWebhookDestination(url, async () => addresses),
      ).rejects.toBeInstanceOf(WebhookDestinationError);
    }
  });

  it('accepts a name whose answers are all global', async () => {
    await expect(
      assertWebhookDestination(url, async () => [PUBLIC_V4, PUBLIC_V6]),
    ).resolves.toBeUndefined();
  });

  it('rejects a name that changes to a private address on the next lookup', async () => {
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return calls === 1 ? [PUBLIC_V4] : ['10.9.9.9'];
    };
    await expect(assertWebhookDestination(url, resolve)).resolves.toBeUndefined();
    await expect(assertWebhookDestination(url, resolve)).rejects.toBeInstanceOf(
      WebhookDestinationError,
    );
  });

  it('does not resolve a cluster name', async () => {
    let called = false;
    await expect(
      assertWebhookDestination('https://api.ns.svc.cluster.local/hook', async () => {
        called = true;
        return [PUBLIC_V4];
      }),
    ).rejects.toBeInstanceOf(WebhookDestinationError);
    expect(called).toBe(false);
  });

  it('treats a transient lookup failure as retryable, and create as a refusal', async () => {
    const resolve = async (): Promise<string[]> => {
      throw new WebhookDnsError();
    };
    await expect(assertWebhookDestination(url, resolve)).rejects.toBeInstanceOf(
      WebhookDnsError,
    );
    await expect(assertWebhookDestinationForCreate(url, resolve)).rejects.toBeInstanceOf(
      WebhookDestinationError,
    );
  });

  it('returns only a checked address from the connect lookup', async () => {
    const lookup = createWebhookLookup(async () => [PUBLIC_V6, PUBLIC_V4]);
    await expect(invokeLookup(lookup, 'hooks.example')).resolves.toBe(PUBLIC_V4);

    const blocked = createWebhookLookup(async () => ['192.168.0.4']);
    await expect(invokeLookup(blocked, 'hooks.example')).rejects.toBeInstanceOf(
      WebhookDestinationError,
    );

    const literal = createWebhookLookup(async () => {
      throw new Error('dns should not run for a literal');
    });
    await expect(invokeLookup(literal, '10.2.3.4')).rejects.toBeInstanceOf(
      WebhookDestinationError,
    );
    await expect(invokeLookup(literal, '8.8.8.8')).resolves.toBe('8.8.8.8');
  });
});

describe('extra webhook deny CIDRs', () => {
  afterEach(() => {
    delete process.env.WEBHOOK_DENY_CIDRS;
    __resetEnvCache();
  });

  it('applies deployment-specific CIDRs on top of the built-in ranges', () => {
    expect(isBlockedIp('203.0.113.10')).toBe(false);
    process.env.WEBHOOK_DENY_CIDRS = '203.0.113.0/24';
    __resetEnvCache();
    expect(isBlockedIp('203.0.113.10')).toBe(true);
    expect(isBlockedIp('203.0.114.10')).toBe(false);
  });
});
