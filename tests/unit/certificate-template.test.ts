import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { renderCertificatePdf } from '@/domains/certificates/render';
import { publishCertificateTemplateSchema } from '@/domains/certificates/schemas';
import {
  canReissue,
  publicCertificateStatus,
  toPublicCertificateView,
} from '@/domains/certificates/status';
import {
  DEFAULT_CERTIFICATE_WORDING,
  detectLogoType,
  formatAbn,
  isCertificatePrintable,
  normalizeCertificateText,
  planTemplatePublish,
  supersededRevokeReason,
  templateContentHash,
  wrapCertificateLines,
} from '@/domains/certificates/template';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('certificate template versioning', () => {
  const hash = templateContentHash({
    wording: DEFAULT_CERTIFICATE_WORDING,
    signatoryName: 'Ada Brown',
    signatoryRole: 'Chair',
    logoSha256: null,
  });

  it('starts at version 1 and bumps only when the content hash changes', () => {
    expect(planTemplatePublish(null, hash)).toEqual({ action: 'publish', version: 1 });
    expect(planTemplatePublish({ version: 1, contentHash: hash }, hash)).toEqual({
      action: 'unchanged',
      version: 1,
    });
    const next = templateContentHash({
      wording: `${DEFAULT_CERTIFICATE_WORDING} Updated.`,
      signatoryName: 'Ada Brown',
      signatoryRole: 'Chair',
      logoSha256: null,
    });
    expect(planTemplatePublish({ version: 2, contentHash: hash }, next)).toEqual({
      action: 'publish',
      version: 3,
    });
  });

  it('changes the hash when the logo bytes change', () => {
    const withLogo = templateContentHash({
      wording: DEFAULT_CERTIFICATE_WORDING,
      signatoryName: 'Ada Brown',
      signatoryRole: 'Chair',
      logoSha256: 'abc',
    });
    expect(withLogo).not.toBe(hash);
  });

  it('normalises curly punctuation and rejects text the font cannot print', () => {
    expect(normalizeCertificateText('“Hello” — it’s fine')).toBe('"Hello" - it\'s fine');
    expect(isCertificatePrintable('Plain text, with (notes).')).toBe(true);
    expect(isCertificatePrintable('Name with macron \u0101')).toBe(false);
  });

  it('accepts organisation wording and signatory, and rejects a short body', () => {
    expect(
      publishCertificateTemplateSchema.safeParse({
        wording: DEFAULT_CERTIFICATE_WORDING,
        signatoryName: 'Ada Brown',
        signatoryRole: 'Chairperson',
      }).success,
    ).toBe(true);
    expect(
      publishCertificateTemplateSchema.safeParse({
        wording: 'Too short',
        signatoryName: 'Ada Brown',
        signatoryRole: 'Chair',
      }).success,
    ).toBe(false);
  });
});

describe('certificate presentation helpers', () => {
  it('groups an 11-digit ABN and leaves other text untouched', () => {
    expect(formatAbn('51824753556')).toBe('51 824 753 556');
    expect(formatAbn(' 51 824 753 556 ')).toBe('51 824 753 556');
    expect(formatAbn('not-an-abn')).toBe('not-an-abn');
    expect(formatAbn(null)).toBeNull();
  });

  it('detects PNG and JPEG magic bytes and rejects other files', () => {
    expect(detectLogoType(ONE_PX_PNG)).toBe('image/png');
    expect(detectLogoType(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBe('image/jpeg');
    expect(detectLogoType(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });

  it('wraps on width and keeps hard line breaks', () => {
    const widthOf = (line: string) => line.length;
    expect(wrapCertificateLines('one two three', 7, widthOf)).toEqual([
      'one two',
      'three',
    ]);
    expect(wrapCertificateLines('keep\napart', 20, widthOf)).toEqual(['keep', 'apart']);
  });

  it('names the replacement by reference only', () => {
    expect(supersededRevokeReason('CERT-2026-ABCD1234')).toBe(
      'Superseded by CERT-2026-ABCD1234',
    );
  });
});

describe('public verification of a superseded certificate', () => {
  it('says superseded and carries no applicant or replacement detail', () => {
    const view = toPublicCertificateView({
      valid: false,
      reference: 'CERT-2026-ABCD1234',
      organisationName: 'Example Organisation',
      status: 'revoked',
      superseded: true,
      signedOn: '2026-10-13',
      signatureValid: true,
      payloadIntact: true,
    });
    expect(view.status).toBe('superseded');
    expect(view.valid).toBe(false);
    expect(publicCertificateStatus('revoked', false)).toBe('revoked');
    expect(publicCertificateStatus('signed', false)).toBe('signed');
    expect(Object.keys(view).sort()).toEqual([
      'organisationName',
      'payloadIntact',
      'reference',
      'signatureValid',
      'signedOn',
      'status',
      'valid',
    ]);
    expect(JSON.stringify(view)).not.toMatch(/applicant|@|reason|supersededBy/i);
  });

  it('allows re-issue only from a signed certificate', () => {
    expect(canReissue('signed')).toBe(true);
    expect(canReissue('draft')).toBe(false);
    expect(canReissue('revoked')).toBe(false);
  });
});

describe('certificate PDF', () => {
  it('prints organisation wording, logo, signatory, ABN and dates', async () => {
    const pdf = await renderCertificatePdf({
      organisationName: 'Example Organisation',
      abn: '51824753556',
      applicantName: 'Pat Example',
      reference: 'CERT-2026-ABCD1234',
      verificationCode: 'a'.repeat(32),
      issuedOn: '2026-10-13',
      verifyUrl: 'https://example.test/verify/aaaaaaaa',
      wording: 'The committee recorded this confirmation in its own words.',
      signatoryName: 'Ada Brown',
      signatoryRole: 'Chairperson',
      meetingOn: '2026-10-01',
      resolutionOn: '2026-10-02',
      logoPng: ONE_PX_PNG,
    });
    const text = decodePdfLiterals(inflatePdf(pdf));
    expect(text).toContain('Example Organisation');
    expect(text).toContain('ABN 51 824 753 556');
    expect(text).toContain('The committee recorded this confirmation in its own words.');
    expect(text).toContain('Pat Example');
    expect(text).toContain('Ada Brown');
    expect(text).toContain('Chairperson');
    expect(text).toContain('2026-10-01');
    expect(text).toContain('2026-10-02');
    expect(text).toContain('CERT-2026-ABCD1234');
    expect(text).toContain('/Subtype /Image');
    expect(text).toContain('machine determination');
  });
});

/** pdf-lib flate-compresses page content. Inflate each stream so text is searchable. */
function inflatePdf(pdf: Buffer): string {
  const parts = [pdf.toString('latin1')];
  let offset = 0;
  while (offset < pdf.length) {
    const start = pdf.indexOf('stream', offset);
    if (start < 0) break;
    let dataStart = start + 'stream'.length;
    if (pdf[dataStart] === 0x0d) dataStart += 1;
    if (pdf[dataStart] === 0x0a) dataStart += 1;
    const end = pdf.indexOf('endstream', dataStart);
    if (end < 0) break;
    let dataEnd = end;
    if (pdf[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (pdf[dataEnd - 1] === 0x0d) dataEnd -= 1;
    try {
      parts.push(inflateSync(pdf.subarray(dataStart, dataEnd)).toString('latin1'));
    } catch {
      // Not a flate stream.
    }
    offset = end + 'endstream'.length;
  }
  return parts.join('\n');
}

/** pdf-lib writes WinAnsi text as hex string literals (`<4578…>`). */
function decodePdfLiterals(text: string): string {
  return text.replace(/<([0-9A-Fa-f\s]+)>/g, (literal, hex: string) => {
    const clean = hex.replace(/\s+/g, '');
    if (clean.length < 4 || clean.length % 2 !== 0) return literal;
    return Buffer.from(clean, 'hex').toString('latin1');
  });
}
