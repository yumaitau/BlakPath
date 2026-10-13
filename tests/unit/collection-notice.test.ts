import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLLECTION_NOTICE_VERSION,
  acknowledgementMatches,
  parseConsentWording,
  resolveCollectionNotice,
} from '@/lib/privacy/collection-notice';

/**
 * Collection notices are resolved per organisation and acknowledged by version
 * + hash. The hash must change whenever anything the person sees changes, and
 * an acknowledgement must only match the exact current notice.
 */
describe('resolveCollectionNotice', () => {
  it('falls back to the draft platform template naming the organisation', () => {
    const notice = resolveCollectionNotice({
      organisationName: 'Example Aboriginal Corporation',
      consentWording: null,
    });
    expect(notice.version).toBe(DEFAULT_COLLECTION_NOTICE_VERSION);
    expect(notice.draft).toBe(true);
    expect(notice.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(notice.paragraphs.join(' ')).toContain('Example Aboriginal Corporation');
    expect(notice.paragraphs.join(' ')).toContain('does not make automated decisions');
    expect(notice.contact).toBeNull();
  });

  it('is deterministic for the same wording', () => {
    const a = resolveCollectionNotice({ organisationName: 'Org', consentWording: null });
    const b = resolveCollectionNotice({ organisationName: 'Org', consentWording: null });
    expect(a.hash).toBe(b.hash);
  });

  it('changes the hash when the organisation or contact changes', () => {
    const base = resolveCollectionNotice({
      organisationName: 'Org',
      consentWording: null,
    });
    const renamed = resolveCollectionNotice({
      organisationName: 'Org Two',
      consentWording: null,
    });
    const withContact = resolveCollectionNotice({
      organisationName: 'Org',
      consentWording: { contact: { email: 'privacy@org.example' } },
    });
    expect(renamed.hash).not.toBe(base.hash);
    expect(withContact.hash).not.toBe(base.hash);
    expect(withContact.version).toBe(DEFAULT_COLLECTION_NOTICE_VERSION);
    expect(withContact.contact).toEqual({
      name: null,
      email: 'privacy@org.example',
      phone: null,
    });
  });

  it('uses organisation-authored wording when paragraphs are configured', () => {
    const notice = resolveCollectionNotice({
      organisationName: 'Org',
      consentWording: {
        version: '2026-11-01',
        title: 'Our collection notice',
        paragraphs: ['We collect this to process your request.'],
        privacyPolicyUrl: 'https://org.example/privacy',
      },
    });
    expect(notice).toMatchObject({
      version: '2026-11-01',
      draft: false,
      title: 'Our collection notice',
      paragraphs: ['We collect this to process your request.'],
      privacyPolicyUrl: 'https://org.example/privacy',
    });
  });

  it('ignores invalid stored wording rather than showing it', () => {
    expect(parseConsentWording({ paragraphs: [] })).toBeNull();
    expect(parseConsentWording({ privacyPolicyUrl: 'javascript:alert(1)' })).toBeNull();
    expect(parseConsentWording({ privacyPolicyUrl: 'http://org.example' })).toBeNull();
    const notice = resolveCollectionNotice({
      organisationName: 'Org',
      consentWording: { paragraphs: 'not an array' },
    });
    expect(notice.draft).toBe(true);
  });
});

describe('acknowledgementMatches', () => {
  const notice = resolveCollectionNotice({
    organisationName: 'Org',
    consentWording: null,
  });

  it('accepts the exact current version and hash', () => {
    expect(
      acknowledgementMatches(notice, { version: notice.version, hash: notice.hash }),
    ).toBe(true);
  });

  it('rejects missing, malformed, stale or mismatched acknowledgements', () => {
    expect(acknowledgementMatches(notice, undefined)).toBe(false);
    expect(acknowledgementMatches(notice, {})).toBe(false);
    expect(acknowledgementMatches(notice, { version: notice.version, hash: 'abc' })).toBe(
      false,
    );
    expect(
      acknowledgementMatches(notice, { version: notice.version, hash: '0'.repeat(64) }),
    ).toBe(false);
    expect(acknowledgementMatches(notice, { version: 'older', hash: notice.hash })).toBe(
      false,
    );
  });
});
