import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
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

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

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
    // Noto Sans covers Latin Extended, so names such as Yolŋu print.
    expect(isCertificatePrintable('Name with macron \u0101 and eng \u014B')).toBe(true);
    expect(isCertificatePrintable('Emoji \u{1F600}')).toBe(false);
    expect(isCertificatePrintable('Tab\there')).toBe(false);
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
      holderBound: true,
    });
    expect(view.status).toBe('superseded');
    expect(view.valid).toBe(false);
    expect(publicCertificateStatus('revoked', false)).toBe('revoked');
    expect(publicCertificateStatus('signed', false)).toBe('signed');
    expect(Object.keys(view).sort()).toEqual([
      'holderBound',
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

describe('certificate PDF', { timeout: 30_000 }, () => {
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
    const text = await pdfText(pdf);
    expect(text).toContain('Example Organisation');
    expect(text).toContain('ABN 51 824 753 556');
    expect(text).toContain('The committee recorded this confirmation in its own words.');
    expect(text).not.toContain('This certifies that the organisation named above');
    expect(text).toContain('Pat Example');
    expect(text).toContain('Ada Brown');
    expect(text).toContain('Chairperson');
    expect(text).toContain('2026-10-01');
    expect(text).toContain('2026-10-02');
    expect(text).toContain('CERT-2026-ABCD1234');
    expect(text).toContain('machine determination');
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
  });

  it('fits the longest allowed wording on one page', async () => {
    const wording = 'Recorded by the committee in its own words. '
      .repeat(27)
      .slice(0, 1200);
    const pdf = await renderCertificatePdf({
      organisationName: 'Example Organisation',
      abn: '51824753556',
      applicantName: 'P'.repeat(120),
      reference: 'CERT-2026-ABCD1234',
      verificationCode: 'a'.repeat(32),
      issuedOn: '2026-10-13',
      verifyUrl: 'https://example.test/verify/aaaaaaaa',
      wording,
      signatoryName: 'Ada Brown',
      signatoryRole: 'Chairperson',
      meetingOn: '2026-10-01',
      resolutionOn: '2026-10-02',
      logoPng: ONE_PX_PNG,
    });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

async function pdfText(pdf: Buffer): Promise<string> {
  const doc = await getDocument({
    data: new Uint8Array(pdf),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  return content.items
    .map((item) => ('str' in item ? item.str : ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}
