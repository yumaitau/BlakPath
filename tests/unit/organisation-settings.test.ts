import { describe, expect, it } from 'vitest';
import { settingsAuditMeta } from '@/domains/organisation-settings/audit-meta';
import {
  domainAfterCheck,
  parseDomain,
  txtProvesControl,
  verificationHostname,
  verificationTxtValue,
} from '@/domains/organisation-settings/dns';
import {
  addDomainSchema,
  brandingSchema,
  consentWordingSchema,
  escalationContactsSchema,
  updateSettingsSchema,
} from '@/domains/organisation-settings/schemas';

const TOKEN = 'abcDEF_123-token';

describe('domain names', () => {
  it('accepts a hostname and rejects urls, wildcards and bare words', () => {
    expect(parseDomain('Council.Example.GOV.AU.')).toEqual({
      ok: true,
      domain: 'council.example.gov.au',
    });
    expect(parseDomain('https://council.example.gov.au').ok).toBe(false);
    expect(parseDomain('*.example.gov.au').ok).toBe(false);
    expect(parseDomain('localhost').ok).toBe(false);
    expect(parseDomain('192.168.0.1').ok).toBe(false);
    expect(addDomainSchema.parse({ domain: 'Council.Example.gov.au' })).toEqual({
      domain: 'council.example.gov.au',
    });
  });
});

describe('dns txt verification', () => {
  it('matches a chunked TXT record and ignores unrelated records', () => {
    const records = [
      ['v=spf1 include:example.com'],
      ['blakpath-verify=', TOKEN.slice(0, 6), TOKEN.slice(6)],
    ];
    expect(txtProvesControl(records, TOKEN)).toBe(true);
    expect(txtProvesControl([[`"blakpath-verify=${TOKEN}"`]], TOKEN)).toBe(true);
    expect(txtProvesControl([[verificationTxtValue('other')]], TOKEN)).toBe(false);
    expect(verificationHostname('council.example.gov.au')).toBe(
      '_blakpath-verify.council.example.gov.au',
    );
  });

  it('marks the domain verified and consumes the single-use token', () => {
    const matched = domainAfterCheck({
      verified: false,
      token: TOKEN,
      records: [[verificationTxtValue(TOKEN)]],
    });
    expect(matched).toEqual({ verified: true, token: null, matched: true });

    const missed = domainAfterCheck({
      verified: false,
      token: TOKEN,
      records: [['something-else']],
    });
    expect(missed).toEqual({ verified: false, token: TOKEN, matched: false });

    const already = domainAfterCheck({
      verified: true,
      token: null,
      records: [],
    });
    expect(already.verified).toBe(true);
    expect(already.matched).toBe(false);
  });
});

describe('settings audit snapshots stay non-PII', () => {
  const secretEmail = 'elder.contact@example.org';
  const secretPhone = '0412345678';
  const secretName = 'Aunty Pat Particular';
  const consentBody = `Contact ${secretName} on ${secretPhone} before sharing.`;

  it('records a digest and lengths for consent wording, not the wording', () => {
    const first = settingsAuditMeta('consentWording', {
      title: 'Consent',
      body: consentBody,
      version: '2026-10',
    });
    const changed = settingsAuditMeta('consentWording', {
      title: 'Consent',
      body: `${consentBody} Updated.`,
      version: '2026-10',
    });
    const encoded = JSON.stringify(first.data);
    expect(encoded).not.toContain(secretName);
    expect(encoded).not.toContain(secretPhone);
    expect(encoded).not.toContain(consentBody);
    expect(first.data.present).toBe(true);
    expect(first.data.summary).toMatchObject({
      bodyLength: consentBody.length,
      version: '2026-10',
      titleLength: 'Consent'.length,
    });
    expect(first.data.digest).not.toBe(changed.data.digest);
    expect(first.allow).toEqual(['field', 'present', 'digest', 'summary']);
  });

  it('keeps escalation contact names, emails and phones out of the snapshot', () => {
    const snapshot = settingsAuditMeta('escalationContacts', {
      contacts: [
        {
          role: 'After hours',
          name: secretName,
          email: secretEmail,
          phone: secretPhone,
        },
      ],
    });
    const encoded = JSON.stringify(snapshot.data);
    expect(encoded).not.toContain(secretName);
    expect(encoded).not.toContain(secretEmail);
    expect(encoded).not.toContain(secretPhone);
    expect(snapshot.data.summary).toMatchObject({
      count: 1,
      roles: ['After hours'],
    });
  });

  it('keeps evidence detail and guidance body text out, and keeps non-PII config', () => {
    const evidence = settingsAuditMeta('evidenceRequirements', {
      intro: `Ask ${secretName}`,
      items: [{ label: 'Birth certificate', detail: secretEmail, required: true }],
    });
    expect(JSON.stringify(evidence.data)).not.toContain(secretName);
    expect(JSON.stringify(evidence.data)).not.toContain(secretEmail);
    expect(evidence.data.summary).toMatchObject({
      itemCount: 1,
      labels: ['Birth certificate'],
    });

    const branding = settingsAuditMeta('branding', {
      primaryColor: '#1B4D3E',
      logoRef: 'logos/council.png?token=secret-value',
    });
    expect(JSON.stringify(branding.data)).not.toContain('secret-value');
    expect(branding.data.summary).toMatchObject({
      primaryColor: '#1b4d3e',
      hasLogoRef: true,
    });

    const retention = settingsAuditMeta('retentionDefaults', { applicationDays: 365 });
    expect(retention.data.summary).toEqual({ applicationDays: 365 });

    const cleared = settingsAuditMeta('publicGuidance', null);
    expect(cleared.data.present).toBe(false);
    expect(cleared.data.summary).toEqual({});
  });

  it('drops terminology values that look like an email or phone', () => {
    const snapshot = settingsAuditMeta('terminology', {
      applicant: 'Community member',
      duty: secretEmail,
    });
    const encoded = JSON.stringify(snapshot.data);
    expect(encoded).toContain('Community member');
    expect(encoded).not.toContain(secretEmail);
  });
});

describe('settings schemas', () => {
  it('rejects a bad colour and accepts a settings patch', () => {
    expect(brandingSchema.safeParse({ primaryColor: 'green' }).success).toBe(false);
    expect(brandingSchema.safeParse({ primaryColor: '#1B4D3E' }).success).toBe(true);
    expect(updateSettingsSchema.parse({ field: 'branding', value: null })).toEqual({
      field: 'branding',
      value: null,
    });
    expect(
      escalationContactsSchema.safeParse({ contacts: [{ role: 'Duty' }] }).success,
    ).toBe(false);
    expect(
      consentWordingSchema.safeParse({ body: 'We record your consent.' }).success,
    ).toBe(true);
  });
});
